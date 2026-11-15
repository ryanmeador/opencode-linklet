import { Plugin } from "@opencode/plugin";
import { connect } from "./connection.js";
import { Linklet, type CreateInput, type FindInput } from "./linklet.js";
import { syntheticTransport, type Delivery } from "./transport.js";
import { actions } from "./policy.js";
import { projectOutput, sessionOutput, createOutput, sendOutput, toolResult, projectText, sessionText, createText, sendText } from "./results.js";

const string = { type: "string", minLength: 1 } as const;
const limit = { type: "integer", minimum: 1, maximum: 100, description: "Maximum results per page, from 1 to 100. Defaults to 20." } as const;
const object = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: "object" as const, properties, required, additionalProperties: false });

export default Plugin.define({
  id: "linklet",
  async setup(ctx) {
    if (ctx.app.version !== "2.2.6")
      throw new Error(`This Linklet release supports OpenCode 2.2.6, but this server is running ${ctx.app.version}. Use OpenCode 2.2.6 with this release, or update Linklet to support your server version.`);
    // Lazy connection: setup must not call back into HTTP while this location's
    // plugins are still activating. Failed connections are not cached forever.
    const transport = syntheticTransport(input => ctx.session.synthetic(input));
    let pending: Promise<Linklet> | undefined;
    const service = () => pending ??= connect(ctx.options).then(client => new Linklet(ctx, client, transport)).catch(error => {
      pending = undefined;
      throw error;
    });
    return register(ctx, service, transport.guidance);
  },
});

/** Registration is separate from connection discovery so hooks can be contract-tested. */
export async function register(ctx: Plugin.Context, service: () => Promise<Linklet>, guidance: string): Promise<() => void> {
    const nativeCalls = new Map<string, { existing: Set<string>; continuation?: string; agentID: string }>();
    await ctx.permission.hook("evaluate", async event => {
      if (event.action === "subagent" && event.agent && event.source) {
        const linklet = await service(), caller = await linklet.caller({ sessionID: event.sessionID,
          agent: event.agent, messageID: event.source.messageID, id: event.source.id });
        const admitted = nativeCalls.get(event.source.id);
        for (const agentID of event.resources) {
          if (admitted?.agentID === agentID) continue;
          await linklet.authorizePeer({ sessionID: event.sessionID, agent: event.agent,
            messageID: event.source.messageID, id: event.source.id }, caller.peer,
            { sessionID: "new-native-child", agentID }, false);
          if (admitted) {
            // A native continuation may switch the child to its requested agent.
            // Record only a successfully authorized switch, for both mid-task
            // parentage checks and durable channel persistence after execution.
            admitted.agentID = agentID;
            linklet.beginNativeCall(event.source.id, caller.peer, agentID);
          }
        }
        return;
      }
      if (!Object.values(actions).includes(event.action as typeof actions[keyof typeof actions])) return;
      await (await service()).permissionHook(event);
    });
    await ctx.tool.transform(editor => {
      editor.namespace({ name: "linklet", description: "Find projects and sessions, create independent sessions, and exchange messages. Use the native subagent tool for self-contained delegated tasks." });
      editor.add({ name: "find_projects", description: "Find registered projects and saved checkout directories, including projects with no sessions. Searches this project unless all is true. Ask the human which project to use if several match.",
        input: object({
          all: { type: "boolean", description: "Set true to search all registered projects. May ask for approval to look outside this project. Defaults to false." },
          search: { ...string, description: "Search project IDs, names, and canonical checkout paths using case-insensitive words. Omit to list projects without a text filter." },
          limit,
          offset: { type: "integer", minimum: 0, description: "Copy nextOffset from the previous result to continue. Omit to start at the first result." },
        }),
        output: projectOutput,
        options: { namespace: "linklet", permission: actions.projects, codemode: true },
        execute: async (input, call) => toolResult(await (await service()).findProjects(input as { all?: boolean; search?: string; limit?: number; offset?: number }, call), projectText),
      });
      editor.add({ name: "find_sessions", description: "Find sessions and activity without reading conversations. Searches this project by default; archived sessions are excluded. Idle is not proof of success; unknown means activity could not be checked.",
        input: object({
          project: { ...string, description: "Project ID, name, or canonical checkout path; this session's current or registered checkout also identifies its project. Omit to search this session's project. Another project may require approval. Do not combine with all: true." },
          all: { type: "boolean", description: "Set true to search sessions across all projects; may ask for approval. Do not combine with project. Defaults to false." },
          search: { ...string, description: "Text to search session titles. Omit to list sessions without a text filter." },
          relationship: { enum: ["all", "roots", "siblings"], description: "all (default): include independent and native child sessions. roots: independent sessions only. siblings: other sessions with this session's native parent; for a root caller, other root sessions. Creator IDs do not determine siblings." },
          activeSince: { ...string, format: "date-time", description: "ISO 8601 cutoff with a timezone, such as 2026-11-08T12:00:00Z. Include sessions with a known execution start/end on or after the cutoff, or currently running sessions. Viewing or editing session metadata does not count. Unknown execution times alone do not match." },
          limit,
          cursor: { ...string, description: "Copy nextCursor from the previous result. Keep project/all, search, relationship, and activeSince unchanged. Sibling searches must use the same caller session. Omit to start a new search." },
          sessionID: { ...string, description: "Look up one exact session ID, including activity and known execution time. Other search, project, relationship, time, and paging options are ignored. A session in another project may require discovery approval." },
        }),
        output: sessionOutput,
        options: { namespace: "linklet", permission: actions.sessions, codemode: true },
        execute: async (input, call) => toolResult(await (await service()).findSessions(input as FindInput, call), sessionText),
      });
      editor.add({ name: "create_session", description: "Create an independent session without copied history or waiting for completion. Ask for a reply if you need results. Do not retry uncertain creation.",
        input: object({
          project: { ...string, description: "Project ID, name, or canonical checkout path; this session's current or registered checkout also identifies its project. Omit to use this session's actual current directory. An explicit project uses its default checkout unless checkout is supplied." },
          checkout: { ...string, description: "An existing registered checkout directory in project. Requires project. Omit to use that project's default checkout." },
          title: { ...string, description: "Optional descriptive title. Give idle sessions a useful title so they are easy to find later." },
          agent: { ...string, description: "Exact agent ID or unique display name at the destination, such as build or Plan. Must support primary sessions, not subagent-only use. Omit to use the destination's default agent, not this session's agent." },
          model: { ...object({
            providerID: { ...string, description: "Exact provider ID from opencode.models." },
            id: { ...string, description: "Exact model ID without the provider prefix." },
            variant: { ...string, description: "Optional exact variant supported by this model." },
          }, ["providerID", "id"]), description: "Optional model override using exact IDs. Omit to use the destination's model defaults, not this session's selected model." },
          worktree: { ...object({ name: { ...string, description: "Optional name for the new worktree. OpenCode chooses one if omitted." } }),
            description: "Include this to create a new worktree using OpenCode's configured strategy and destination. Omit to use an existing checkout. Do not repeat this request after an uncertain creation." },
          task: { type: "string", description: "Optional initial assignment, up to 65,536 UTF-8 bytes. Omit to leave the session idle. Request a reply for results or failures." },
        }),
        output: createOutput,
        options: { namespace: "linklet", permission: actions.create, codemode: true },
        execute: async (input, call) => toolResult(await (await service()).create(input as CreateInput, call), createText),
      });
      editor.add({ name: "send_message", description: "Send to one session ID. Acceptance is not completion. Do not retry uncertain sends or send receipt-only acknowledgements.",
        input: object({
          sessionID: { ...string, description: "Exact recipient session ID. No names, parent/creator aliases, or multiple recipients. Known IDs can be messaged across projects, subject to permissions." },
          text: { type: "string", description: "Complete message text, including whitespace; maximum 65,536 UTF-8 bytes. Oversize messages fail without truncation or automatic splitting." },
          delivery: { enum: ["steer", "queue", "fyi"], description: "steer (default): next model step, waking an idle session. queue: after current work, waking an idle session. fyi: next model step if running, without waking an idle session. Input order is not guaranteed; later human input can cause a pending FYI to be read." },
        }, ["sessionID", "text"]),
        output: sendOutput,
        options: { namespace: "linklet", permission: actions.send, codemode: false },
        execute: async (input, call) => {
          const args = input as { sessionID: string; text: string; delivery?: Delivery };
          return toolResult(await (await service()).send(args, call), sendText);
        },
      });
    });
    await ctx.session.hook("context", async event => {
      const session = await ctx.session.get({ sessionID: event.sessionID });
      const creator = await ctx.storage.get(`v1/creator/${encodeURIComponent(session.id)}`);
      event.system.push({ type: "text", text: [
        "Use the native subagent tool for self-contained delegated tasks and rely on its result delivery. " +
        "Use Linklet for separate sessions that can continue independently; new sessions do not inherit this conversation. " +
        "Request replies for results or failures. " +
        "Avoid duplicate results, receipt-only acknowledgements, and unnecessary progress checks.",
        guidance,
        session.parentID ? `Parent session (native subagent): ${session.parentID}.` : "",
        typeof creator === "string" ? `Created by session: ${creator}. This session is independent; its creator is not its parent.` : "",
      ].filter(Boolean).join("\n") });
    });

    // Observe, authorize, and record native children. Never wrap or replace the
    // native executor, background mechanism, or final-result delivery.
    const children = async (sessionID: string) => {
      const result = [];
      let cursor: string | undefined;
      do {
        const page = await ctx.session.list({ parentID: sessionID, archived: false, limit: 100, ...(cursor ? { cursor } : {}) });
        result.push(...page.data.filter(child => child.parentID === sessionID && child.time.archived === undefined));
        cursor = page.cursor.next ?? undefined;
      } while (cursor);
      return result;
    };
    await ctx.tool.hook("execute.before", async event => {
      if (event.tool !== "subagent") return;
      const input = event.input as { agent?: string; sessionID?: string };
      const linklet = await service();
      const caller = await linklet.caller(event);
      let recipient;
      if (input.sessionID) recipient = (await linklet.target(input.sessionID)).peer;
      else {
        const agents = await linklet.agents(caller.session.location.directory);
        const agent = agents.find(agent => agent.id === input.agent);
        if (!agent) throw new Error(`Linklet could not find subagent ${JSON.stringify(input.agent)} in this directory. Use an exact agent ID from OpenCode's subagent tool.`);
        recipient = { sessionID: "new-native-child", agentID: agent.id };
      }
      await linklet.authorizePeer(event, caller.peer, recipient, !!input.sessionID);
      nativeCalls.set(event.id, { existing: new Set((await children(event.sessionID)).map(child => child.id)),
        continuation: input.sessionID, agentID: recipient.agentID });
      linklet.beginNativeCall(event.id, caller.peer, recipient.agentID);
    });
    await ctx.tool.hook("execute.after", async event => {
      if (event.tool !== "subagent") return;
      const admitted = nativeCalls.get(event.id);
      nativeCalls.delete(event.id);
      if (!admitted) return;
      try {
        const linklet = await service(), caller = await linklet.caller(event);
        for (const child of await children(event.sessionID)) {
          if (admitted.existing.has(child.id) && admitted.continuation !== child.id) continue;
          const agentID = await linklet.effectiveAgent(child);
          if (agentID !== admitted.agentID) continue;
          await linklet.channels.establish(caller.peer, { sessionID: child.id, agentID });
        }
      } catch {
        // Preserve the native result even if Linklet's auxiliary persistence fails.
        if (event.status === "completed") event.result = { ...event.result, metadata: { ...event.result.metadata,
          linkletWarning: "The subagent's result is unchanged, but Linklet could not save its reply relationship. Follow-up messages may need approval again." } };
      } finally {
        (await service()).endNativeCall(event.id);
      }
    });
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ["session.created"], signal: controller.signal })) {
          if (!event.data.parentID || ![...nativeCalls.values()].some(call => call.agentID === event.data.agent)) continue;
          try {
            const linklet = await service();
            await linklet.recordNativeChild(await ctx.session.get({ sessionID: event.data.sessionID }));
          } catch { /* Send-time parentage checks and execute.after remain available. */ }
        }
      } catch { /* No custom event replay/broker; host parentage checks fail closed. */ }
    })();
    return () => { controller.abort(); nativeCalls.clear(); };
}
