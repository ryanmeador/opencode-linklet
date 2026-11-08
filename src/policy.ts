import type { AgentInfo, PermissionRuleset } from "@opencode/client";
import type { Identity } from "./transport.js";

export const actions = {
  projects: "linklet.find_projects", sessions: "linklet.find_sessions",
  create: "linklet.create_session", send: "linklet.send_message",
  discover: "linklet.cross_project_discovery", crossCreate: "linklet.cross_project_creation",
  crossAgent: "linklet.cross_agent",
} as const;
export const askByDefault: readonly string[] = [actions.discover, actions.crossCreate, actions.crossAgent];

export function match(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*").replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "i" : "").test(value);
}

// The host owns rule precedence, denials, policies, and approval scope. This only
// distinguishes deliberate Linklet preauthorization from the default '*' grant.
export function explicitGrant(rules: PermissionRuleset, action: string, resources: readonly string[]): boolean {
  return resources.every(resource => {
    const last = rules.filter(rule => match(rule.action, action) && match(rule.resource, resource)).at(-1);
    return last?.effect === "allow" && last.action !== "*";
  });
}
export function needsCrossAgent(sender: Identity, recipient: Identity, channel: boolean): boolean {
  return !channel && sender.agentID !== recipient.agentID && recipient.agentID !== "plan";
}

export function selectAgent(agents: readonly AgentInfo[], selection: string): AgentInfo {
  const exact = agents.find(agent => agent.id === selection);
  const matches = exact ? [exact] : agents.filter(agent => agent.name === selection);
  if (matches.length !== 1 || matches[0].hidden || matches[0].mode === "subagent") {
    const reason = matches.length === 0 ? `No agent matches ${JSON.stringify(selection)}.` : matches.length > 1
      ? `More than one agent is named ${JSON.stringify(selection)}. Use an exact agent ID.`
      : `Agent ${JSON.stringify(selection)} cannot be used for an independent session; choose a visible agent that supports primary sessions.`;
    const choices = agents.filter(agent => !agent.hidden && agent.mode !== "subagent")
      .map(agent => `${agent.id} (${agent.name})`).join(", ");
    throw new Error(`${reason} Available agents: ${choices || "none"}.`);
  }
  return matches[0];
}

export function defaultAgent(agents: readonly AgentInfo[], configured?: string): AgentInfo {
  const eligible = agents.filter(agent => !agent.hidden && agent.mode !== "subagent");
  const selected = eligible.find(agent => agent.id === configured) ?? eligible.find(agent => agent.id === "build") ?? eligible[0];
  if (!selected) throw new Error("No agents are available for an independent session in the selected directory. Enable Build, Plan, or another visible primary agent there, or choose another project.");
  return selected;
}

export interface Channel { version: 1; endpoints: [Identity, Identity] }
export interface Store {
  get(key: string): Promise<unknown>;
  set(key: string, value: Channel): Promise<void>;
}
export class Channels {
  constructor(private readonly storage: Store) {}
  private key(a: Identity, b: Identity): string {
    return `v1/channel/${[a.sessionID, b.sessionID].sort().map(encodeURIComponent).join("/")}`;
  }
  async has(a: Identity, b: Identity): Promise<boolean> {
    const value = await this.storage.get(this.key(a, b)) as Channel | undefined;
    return value?.version === 1 && Array.isArray(value.endpoints) && [a, b].every(identity =>
      value.endpoints.some(endpoint => endpoint.sessionID === identity.sessionID && endpoint.agentID === identity.agentID));
  }
  async establish(a: Identity, b: Identity): Promise<void> {
    await this.storage.set(this.key(a, b), { version: 1, endpoints: [a, b] });
  }
}
