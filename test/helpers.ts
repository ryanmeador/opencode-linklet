import type { Plugin } from "@opencode/plugin";
import type { AgentInfo, OpenCodeClient, SessionInfo, PermissionRuleset } from "@opencode/client";
import { Linklet, type Call } from "../src/linklet.js";

export const call: Call = { sessionID: "ses_caller", agent: "build", messageID: "msg_test", id: "call_test" };
export const agent = (id: string, options: Partial<AgentInfo> = {}): AgentInfo => ({
  id, name: id === "build" ? "Build" : id === "plan" ? "Plan" : id,
  mode: "primary", hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [{ action: "*", resource: "*", effect: "allow" }], ...options,
});
export const session = (id: string, options: Partial<SessionInfo> = {}): SessionInfo => ({
  id, agent: "build", projectID: "project_one", location: { directory: "/one/subdir" },
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: {} as SessionInfo["tokens"], ...options,
});

export function fixture() {
  const sessions = new Map<string, SessionInfo>([[call.sessionID, session(call.sessionID)], ["ses_peer", session("ses_peer")]]);
  const storage = new Map<string, unknown>();
  const agents = [agent("build"), agent("plan"), agent("review"), agent("explore", { mode: "subagent" })];
  const checks: { action: string; resources: string[]; metadata?: Record<string, unknown> }[] = [];
  const admissions: unknown[] = [];
  const resources: unknown[] = [];
  let denied: string | undefined;
  const state = {
    permissions: [] as PermissionRuleset,
    saved: [] as { action: string; resource: string; projectID: string }[],
    active: {} as Record<string, { type: "running" }>,
    pending: [] as unknown[], forms: [] as unknown[],
    defaultAgent: "build", failStorage: false, failAdmission: false, failCreation: false,
    projects: [
      { id: "project_one", canonical: "/one", name: "One", time: {}, sandboxes: [] },
      { id: "project_two", canonical: "/two", name: "Hollow sphere", time: {}, sandboxes: [] },
      { id: "project_empty", canonical: "/empty", name: "Empty", time: {}, sandboxes: [] },
    ],
  };
  const ctx = {
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        if (state.failStorage) throw new Error("storage offline");
        storage.set(key, structuredClone(value));
      },
    },
    agent: {
      list: async () => ({ data: agents }),
      get: async ({ agentID }: { agentID: string }) => ({ data: { ...agents.find(agent => agent.id === agentID), permissions: state.permissions } }),
    },
    permission: {
      assert: async (input: { action: string; resources: string[] }) => {
        checks.push(input);
        if (input.action === denied) throw new Error("host permission denied");
      },
      list: async () => state.pending,
    },
    worktree: {
      list: async ({ projectID }: { projectID: string }) => [{ directory: projectID === "project_one" ? "/one" : "/two" }],
      create: async (input: unknown) => { resources.push(input); return { directory: "/new-worktree" }; },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const value = sessions.get(sessionID);
        if (!value) throw Object.assign(new Error("missing"), { _tag: "SessionNotFoundError" });
        return value;
      },
      list: async (input: { project?: string; archived?: boolean; parentID?: string }) => ({
        data: [...sessions.values()].filter(session => (!input.project || session.projectID === input.project) &&
          (!input.parentID || session.parentID === input.parentID) && (input.archived !== false || session.time.archived === undefined)), cursor: {},
      }),
      create: async (input: { location: { directory: string }; agent?: string }) => {
        resources.push(input);
        if (state.failCreation) throw new Error("timeout");
        const created = session(`ses_new_${sessions.size}`, { location: input.location, agent: input.agent ?? state.defaultAgent });
        sessions.set(created.id, created);
        return created;
      },
      synthetic: async (input: unknown) => {
        admissions.push(input);
        if (state.failAdmission) throw new Error("timeout");
        return { id: "inbox_test" };
      },
    },
  } as unknown as Plugin.Context;
  const client = {
    agent: ctx.agent,
    project: { list: async () => state.projects },
    config: { get: async () => [{ type: "document", info: { default_agent: state.defaultAgent } }] },
    permission: { saved: { list: async () => state.saved } },
    session: { active: async () => state.active, form: { list: async () => state.forms } },
    model: { list: async () => ({ data: [] }) },
  } as unknown as OpenCodeClient;
  return { ctx, client, linklet: new Linklet(ctx, client), sessions, storage, agents, checks, admissions, resources, state,
    deny: (action: string) => { denied = action; } };
}
