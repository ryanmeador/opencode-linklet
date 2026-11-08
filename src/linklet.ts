import type { Plugin } from "@opencode/plugin";
import type { OpenCodeClient, SessionInfo, AgentInfo, ModelRef, Project } from "@opencode/client";
import { actions, askByDefault, Channels, defaultAgent, explicitGrant, match, needsCrossAgent, selectAgent } from "./policy.js";
import { syntheticTransport, validateBody, type Identity, type Transport, type Delivery } from "./transport.js";

export interface Call {
  sessionID: string; agent: string; messageID: string; id: string;
  signal?: AbortSignal;
}
export interface CreateInput {
  project?: string; checkout?: string; title?: string; agent?: string;
  model?: ModelRef; worktree?: { name?: string }; task?: string;
}
export interface FindInput { project?: string; all?: boolean; search?: string; limit?: number; cursor?: string; sessionID?: string }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const knownRejection = (error: unknown) => error instanceof RetainedResourceError || !!error && typeof error === "object" &&
  "_tag" in error && ["InvalidRequestError", "AgentNotFoundError", "ModelNotFoundError", "UnauthorizedError", "ForbiddenError", "WorktreeError", "ProjectNotFoundError"].includes(String(error._tag));
class RetainedResourceError extends Error {}
const identity = (session: SessionInfo, agentID: string): Identity => ({ sessionID: session.id, agentID });
const permissionMessages: Record<string, string> = {
  [actions.projects]: "Allow Linklet to list registered projects and their checkout directories?",
  [actions.sessions]: "Allow Linklet to look up session titles, locations, and activity? Conversation history is not included.",
  [actions.create]: "Allow Linklet to create an independent session? It may receive an initial task, but it will not inherit this conversation.",
  [actions.send]: "Allow Linklet to send a message to another session?",
  [actions.discover]: "Allow Linklet to look up projects or sessions outside this project? Conversation history is not included.",
  [actions.crossCreate]: "Allow Linklet to create a session in another project?",
  [actions.crossAgent]: "Allow Linklet to create or message a session that uses a different agent?",
};
function projectCandidates(projects: Project[], selector: string): Project[] {
  const exact = projects.filter(project => project.id === selector || project.canonical === selector);
  const tokens = selector.toLocaleLowerCase().split(/[\s_-]+/).filter(Boolean);
  return exact.length ? exact : projects.filter(project => {
    const text = `${project.name ?? ""} ${project.canonical}`.toLocaleLowerCase();
    return tokens.every(token => text.includes(token));
  });
}

export class Linklet {
  readonly channels: Channels;
  readonly transport: Transport;
  private readonly nativePending = new Map<string, { parent: Identity; agentID: string }>();
  constructor(readonly ctx: Plugin.Context, readonly client: OpenCodeClient, transport?: Transport) {
    this.channels = new Channels({
      get: key => ctx.storage.get(key),
      set: (key, channel) => ctx.storage.set(key, { version: channel.version,
        endpoints: channel.endpoints.map(endpoint => ({ ...endpoint })) }),
    });
    this.transport = transport ?? syntheticTransport(input => ctx.session.synthetic(input));
  }

  async assert(call: Call, action: string, resource = "*", metadata?: Record<string, unknown>) {
    call.signal?.throwIfAborted();
    await this.ctx.permission.assert({ sessionID: call.sessionID, agent: call.agent,
      source: { type: "tool", messageID: call.messageID, id: call.id },
      action, resources: [resource], save: [action === actions.crossAgent ? "*" : resource],
      ...(metadata ? { metadata } : {}) });
    call.signal?.throwIfAborted();
  }

  // HTTP location routes await destination activation. Native registry reads may
  // return a not-yet-populated registry while a different location boots.
  async agents(directory: string) { return (await this.client.agent.list({ location: { directory } })).data; }
  async effectiveAgent(session: SessionInfo): Promise<string> {
    const agents = await this.agents(session.location.directory);
    if (session.agent) {
      if (!agents.some(agent => agent.id === session.agent)) throw new Error(`This session uses agent ${JSON.stringify(session.agent)}, which is not available in its current directory. Check that directory's agent configuration before trying again.`);
      return session.agent;
    }
    return (await this.destinationDefaults(session.location.directory, agents)).id;
  }
  async destinationDefaults(directory: string, agents: readonly AgentInfo[]) {
    const entries = await this.client.config.get({ location: { directory } });
    let configured: string | undefined;
    for (const entry of entries) if (entry.type === "document" && entry.info.default_agent !== undefined)
      configured = entry.info.default_agent;
    return defaultAgent(agents, configured);
  }
  async validateModel(model: ModelRef, directory: string) {
    const models = (await this.client.model.list({ location: { directory }, types: ["chat"] })).data;
    const selected = models.find(candidate => candidate.providerID === model.providerID && candidate.id === model.id && candidate.enabled);
    if (!selected || model.variant && !selected.variants.some(variant => variant.id === model.variant))
      throw new Error(`Model ${JSON.stringify(`${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`)} is not available in the selected directory. Use opencode.models to choose an available model and variant by their exact IDs.`);
  }
  async caller(call: Call) {
    const session = await this.ctx.session.get({ sessionID: call.sessionID });
    // Execution identity wins over the session's current/default selection.
    const agent = (await this.agents(session.location.directory)).find(item => item.id === call.agent);
    if (!agent) throw new Error(`The agent running this tool (${JSON.stringify(call.agent)}) is not available in this session's directory. Check the agent configuration before trying again.`);
    return { session, peer: identity(session, agent.id) };
  }
  async target(sessionID: string) {
    const session = await this.ctx.session.get({ sessionID });
    if (session.time.archived !== undefined) throw new Error("This session is archived, so Linklet cannot use it. Choose an unarchived session from find_sessions.");
    return { session, peer: identity(session, await this.effectiveAgent(session)) };
  }
  beginNativeCall(callID: string, parent: Identity, agentID: string) {
    this.nativePending.set(callID, { parent, agentID });
  }
  endNativeCall(callID: string) { this.nativePending.delete(callID); }
  async recordNativeChild(child: SessionInfo): Promise<void> {
    if (!child.parentID) return;
    const agentID = await this.effectiveAgent(child);
    for (const pending of this.nativePending.values()) {
      if (pending.parent.sessionID === child.parentID && pending.agentID === agentID) {
        await this.channels.establish(pending.parent, identity(child, agentID));
        return;
      }
    }
  }
  async authorizePeer(call: Call, sender: Identity, recipient: Identity, existingRecipient = true) {
    let channel = await this.channels.has(sender, recipient);
    // A foreground native child can send a mid-task message before the parent's
    // tool returns or the created event is processed. Confirm host parentage,
    // never text/metadata, against an already authorized in-flight native call.
    if (!channel && existingRecipient) {
      for (const pending of this.nativePending.values()) {
        const child = pending.parent.sessionID === sender.sessionID && pending.parent.agentID === sender.agentID && pending.agentID === recipient.agentID ? recipient :
          pending.parent.sessionID === recipient.sessionID && pending.parent.agentID === recipient.agentID && pending.agentID === sender.agentID ? sender : undefined;
        if (!child) continue;
        const actual = await this.ctx.session.get({ sessionID: child.sessionID });
        if (actual.parentID !== pending.parent.sessionID) continue;
        await this.channels.establish(sender, recipient);
        channel = true;
        break;
      }
    }
    // A separate assert even for channels lets explicit denials override them.
    await this.assert(call, actions.crossAgent, "*", {
      "linklet.v1": { requiresApproval: needsCrossAgent(sender, recipient, channel) },
    });
  }

  async permissionHook(event: {
    sessionID: string; agent?: string; action: string; resources: readonly string[];
    metadata?: Record<string, unknown>; source?: { type: "tool"; messageID: string; id: string };
    effect: "allow" | "ask" | "deny"; message?: string;
  }) {
    if (event.effect === "deny") return;
    if (!askByDefault.includes(event.action)) {
      if (event.effect === "ask" && permissionMessages[event.action]) event.message = permissionMessages[event.action];
      return;
    }
    const metadata = event.metadata?.["linklet.v1"] as { requiresApproval?: boolean } | undefined;
    if (event.action === actions.crossAgent && metadata?.requiresApproval === false) {
      event.effect = "allow";
      return;
    }
    const session = await this.ctx.session.get({ sessionID: event.sessionID });
    const agentID = event.agent ?? await this.effectiveAgent(session);
    const agent = (await this.client.agent.get({ agentID, location: session.location })).data;
    const rules = [...agent.permissions, ...(session.permissions ?? [])];
    const saved = await this.client.permission.saved.list({ projectID: session.projectID });
    if (explicitGrant(rules, event.action, event.resources) || event.resources.every(resource =>
      saved.some(grant => grant.action !== "*" && match(grant.action, event.action) && match(grant.resource, resource)))) return;
    event.effect = "ask";
    event.message = permissionMessages[event.action];
  }

  async project(selector: string, boundary?: { call: Call; callerProjectID: string; action: string }): Promise<Project> {
    const projects = await this.client.project.list({ archived: false });
    const candidates = projectCandidates(projects, selector);
    // Matching is private until authorized. Do not leak cross-project candidate
    // names/paths in an ambiguity error before the boundary approval.
    if (boundary && (candidates.length !== 1 || candidates[0].id !== boundary.callerProjectID))
      await this.assert(boundary.call, boundary.action, candidates.length === 1 ? candidates[0].id : selector);
    if (!candidates.length)
      throw new Error(`No registered project matches ${JSON.stringify(selector)}. Use find_projects with all: true to search other projects, then choose an exact project ID.`);
    if (candidates.length !== 1)
      throw new Error(`More than one project matches ${JSON.stringify(selector)}. Ask which project to use, then use its exact project ID. Matching projects: ` +
        JSON.stringify(candidates.slice(0, 20).map(project => ({ id: project.id, name: project.name, directory: project.canonical }))));
    return candidates[0];
  }

  async findProjects(input: { all?: boolean; search?: string; limit?: number; offset?: number }, call: Call) {
    await this.assert(call, actions.projects);
    const { session } = await this.caller(call);
    if (input.all) await this.assert(call, actions.discover);
    const all = await this.client.project.list({ archived: false });
    const tokens = (input.search ?? "").toLocaleLowerCase().split(/[\s_-]+/).filter(Boolean);
    const matches = all.filter(project => (input.all || project.id === session.projectID) &&
      tokens.every(token => `${project.id} ${project.name ?? ""} ${project.canonical}`.toLocaleLowerCase().includes(token)));
    const offset = input.offset ?? 0, limit = Math.min(input.limit ?? 20, 100);
    const projects = await Promise.all(matches.slice(offset, offset + limit).map(async project => ({
      id: project.id, name: project.name, canonical: project.canonical,
      checkouts: await this.ctx.worktree.list({ projectID: project.id }),
    })));
    return { projects, nextOffset: offset + limit < matches.length ? offset + limit : null };
  }

  async activity(session: SessionInfo) {
    const [active, permissions, forms] = await Promise.allSettled([
      this.client.session.active(), this.ctx.permission.list({ sessionID: session.id }),
      this.client.session.form.list({ sessionID: session.id }),
    ]);
    if (permissions.status === "fulfilled" && permissions.value.length)
      return { activity: "blocked", reason: "waiting for permission approval" };
    if (forms.status === "fulfilled" && forms.value.length)
      return { activity: "blocked", reason: "waiting for input" };
    if (active.status === "fulfilled" && active.value[session.id]) return { activity: "running" };
    if (active.status === "fulfilled" && permissions.status === "fulfilled" && forms.status === "fulfilled")
      return { activity: "idle" };
    return { activity: "unknown" };
  }
  async summary(session: SessionInfo) {
    const creator = await this.ctx.storage.get(`v1/creator/${encodeURIComponent(session.id)}`);
    return { sessionID: session.id, title: session.title, projectID: session.projectID,
      directory: session.location.directory, parentID: session.parentID,
      ...(typeof creator === "string" ? { creatorID: creator } : {}), ...await this.activity(session) };
  }
  async findSessions(input: FindInput, call: Call) {
    await this.assert(call, actions.sessions);
    const { session } = await this.caller(call);
    if (input.sessionID) {
      const target = await this.ctx.session.get({ sessionID: input.sessionID });
      if (target.projectID !== session.projectID) await this.assert(call, actions.discover, target.projectID);
      if (target.time.archived !== undefined) throw new Error("This session is archived, so Linklet does not return its details. Choose an unarchived session from find_sessions.");
      return { sessions: [await this.summary(target)], nextCursor: null };
    }
    if (input.all && input.project) throw new Error("Use project to choose one project, or all: true to search all projects—not both.");
    if (input.all) await this.assert(call, actions.discover);
    const projectID = input.all ? undefined : input.project ? (await this.project(input.project, {
      call, callerProjectID: session.projectID, action: actions.discover,
    })).id : session.projectID;
    // Never accept raw host cursors: their embedded filters could widen access.
    let hostCursor: string | undefined;
    if (input.cursor) {
      let cursor: { version: number; projectID?: string; search?: string; host: string };
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
        if (!cursor || cursor.version !== 1 || typeof cursor.host !== "string") throw new Error("invalid cursor");
      } catch {
        throw new Error("This page token is invalid. Copy nextCursor from the previous result into cursor, or omit cursor to start a new search.");
      }
      if (cursor.projectID !== projectID || cursor.search !== input.search)
        throw new Error("This page token belongs to a different search. Keep project/all and search unchanged, or omit cursor to start a new search.");
      // Host cursors are stored, not trusted from caller-controlled encoding.
      const saved = await this.ctx.storage.get(`v1/cursor/${encodeURIComponent(cursor.host)}`);
      if (saved !== JSON.stringify({ projectID, search: input.search })) throw new Error("This page token was not issued by Linklet, or is no longer available. Omit cursor to start a new search.");
      hostCursor = cursor.host;
    }
    const page = await this.ctx.session.list({ ...(projectID ? { project: projectID } : {}),
      ...(input.search ? { search: input.search } : {}), archived: false, limit: Math.min(input.limit ?? 20, 100),
      ...(hostCursor ? { cursor: hostCursor } : {}) });
    const next = page.cursor.next;
    if (next) await this.ctx.storage.set(`v1/cursor/${encodeURIComponent(next)}`, JSON.stringify({ projectID, search: input.search }));
    return { sessions: await Promise.all(page.data.filter(item => item.time.archived === undefined &&
      (!projectID || item.projectID === projectID)).map(item => this.summary(item))),
      nextCursor: next ? Buffer.from(JSON.stringify({ version: 1, projectID, search: input.search, host: next })).toString("base64url") : null };
  }

  async create(input: CreateInput, call: Call) {
    await this.assert(call, actions.create);
    if (input.task !== undefined) validateBody(input.task);
    if (input.checkout && !input.project) throw new Error("To choose a checkout, also specify its project. Without project, Linklet uses this session's current directory.");
    const caller = await this.caller(call);
    call.signal?.throwIfAborted();
    const destination = input.project ? await this.project(input.project, {
      call, callerProjectID: caller.session.projectID, action: actions.crossCreate,
    }) : undefined;
    call.signal?.throwIfAborted();
    const projectID = destination?.id ?? caller.session.projectID;
    let directory = destination?.canonical ?? caller.session.location.directory;
    if (input.checkout) {
      const checkouts = await this.ctx.worktree.list({ projectID });
      call.signal?.throwIfAborted();
      if (input.checkout !== destination?.canonical && !checkouts.some(item => item.directory === input.checkout))
        throw new Error(`Checkout ${JSON.stringify(input.checkout)} is not registered for the selected project. Use find_projects to choose one of that project's checkout directories.`);
      directory = input.checkout;
    }
    const agents = await this.agents(directory);
    call.signal?.throwIfAborted();
    const agent = input.agent ? selectAgent(agents, input.agent) : await this.destinationDefaults(directory, agents);
    call.signal?.throwIfAborted();
    if (input.model) await this.validateModel(input.model, directory);
    call.signal?.throwIfAborted();
    await this.authorizePeer(call, caller.peer, { sessionID: "new-independent-session", agentID: agent.id }, false);
    call.signal?.throwIfAborted();
    let worktree: string | undefined, created: SessionInfo | undefined;
    let stage = "worktree";
    try {
      if (input.worktree) {
        worktree = (await this.ctx.worktree.create({ projectID, from: directory,
          ...(input.worktree.name ? { name: input.worktree.name } : {}) },
          call.signal ? { signal: call.signal } : undefined)).directory;
        directory = worktree;
        stage = "validation";
        call.signal?.throwIfAborted();
        // New locations may override defaults/eligibility. Never dispatch into a
        // changed agent configuration without validating and authorizing it.
        const newAgents = await this.agents(directory);
        call.signal?.throwIfAborted();
        const newAgent = input.agent ? selectAgent(newAgents, input.agent) : await this.destinationDefaults(directory, newAgents);
        call.signal?.throwIfAborted();
        if (newAgent.id !== agent.id) throw new RetainedResourceError("The new worktree uses a different default agent than the original checkout. The worktree was kept, but no session was created. To continue, specify its project and use the returned directory as checkout; omit worktree so you reuse it.");
        if (input.model) {
          try { await this.validateModel(input.model, directory); }
          catch (error) { throw new RetainedResourceError(errorText(error)); }
        }
      }
      call.signal?.throwIfAborted();
      stage = "session";
      created = await this.ctx.session.create({ location: { directory },
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.agent ? { agent: agent.id } : {}), ...(input.model ? { model: input.model } : {}) },
        call.signal ? { signal: call.signal } : undefined);
    } catch (error) {
      return { status: stage === "validation" || knownRejection(error) ? "failed" : "uncertain", stage, directory, worktree, sessionID: created?.id,
        detail: errorText(error), retained: "Linklet did not delete any resources. Check the returned IDs and paths before creating anything else; repeating this request could create duplicates." };
    }
    const result = { sessionID: created.id, directory, worktree, independent: true };
    const cancelled = () => ({ ...result, status: "created", detail: "The call was cancelled after the session was created. The session was kept idle; no task was sent. Any created worktree was also kept." });
    if (call.signal?.aborted) return cancelled();
    let recipient: Identity;
    try { recipient = identity(created, await this.effectiveAgent(created)); }
    catch (error) {
      return { ...result, status: "created", detail: `The session was created and kept idle, but Linklet could not check which agent it uses. No task was sent. Details: ${errorText(error)}` };
    }
    if (call.signal?.aborted) return cancelled();
    if (recipient.agentID !== agent.id)
      return { ...result, status: "failed", detail: "OpenCode selected a different agent than the one Linklet checked. The session was kept idle. No task was sent, and no reply relationship was saved. Check the destination's agent settings before using this session." };
    try {
      await this.ctx.storage.set(`v1/creator/${encodeURIComponent(created.id)}`, caller.session.id);
      await this.channels.establish(caller.peer, recipient);
    } catch {
      return { ...result, status: "created", detail: "The session was created and kept idle, but Linklet could not save its creator and reply relationship. Future messages may need approval again. No task was sent." };
    }
    if (call.signal?.aborted) return cancelled();
    if (input.task === undefined) return { ...result, status: "created", activity: "idle" };
    const receipt = await this.transport.admit({ sender: caller.peer, recipient, body: input.task, delivery: "steer" });
    return { ...result, status: "created", assignment: receipt,
      detail: "This session does not send results back automatically; ask it to reply when needed. A message marked admitted has been accepted by OpenCode, but the task may not have started or finished." };
  }

  async send(input: { sessionID: string; text: string; delivery?: Delivery }, call: Call) {
    validateBody(input.text);
    await this.assert(call, actions.send, input.sessionID);
    const caller = await this.caller(call), target = await this.target(input.sessionID);
    await this.authorizePeer(call, caller.peer, target.peer);
    const receipt = await this.transport.admit({ body: input.text, sender: caller.peer,
      recipient: target.peer, delivery: input.delivery ?? "steer" });
    if (receipt.status === "admitted") {
      try { await this.channels.establish(caller.peer, target.peer); }
      catch { return { ...receipt, sessionID: input.sessionID, warning: "OpenCode accepted the message, but Linklet could not save the reply relationship. Do not resend the message; replies may need approval again." }; }
    }
    return { ...receipt, sessionID: input.sessionID, delivery: input.delivery ?? "steer" };
  }
}
