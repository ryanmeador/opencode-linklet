import { test } from "node:test";
import assert from "node:assert/strict";
import type { Plugin } from "@opencode/plugin";
import { register } from "../src/index.js";
import { agent, call, fixture, session } from "./helpers.js";

async function registered() {
  const f = fixture();
  const hooks = new Map<string, (event: any) => Promise<void>>();
  const tools: { name: string; input: any; output: any; options: { permission: string; codemode: boolean }; execute: (input: unknown, context: typeof call) => Promise<{ output: any; content: string }> }[] = [];
  const hook = (domain: string) => async (name: string, callback: (event: any) => Promise<void>) => {
    hooks.set(`${domain}/${name}`, callback);
    return { dispose: async () => {} };
  };
  const ctx = { ...f.ctx,
    event: { subscribe: async function* () {} },
    tool: { hook: hook("tool"), transform: async (callback: (editor: unknown) => void) => {
      callback({ namespace: () => {}, add: (tool: typeof tools[number]) => tools.push(tool) });
      return { dispose: async () => {} };
    } },
    permission: { ...f.ctx.permission, hook: hook("permission") },
    session: { ...f.ctx.session, hook: hook("session") },
  } as unknown as Plugin.Context;
  await register(ctx, async () => f.linklet, f.linklet.transport.guidance);
  return { ...f, hooks, tools };
}
test("registers exactly four focused tools, with independent capability permissions and closed schemas", async () => {
  const f = await registered();
  assert.deepEqual(f.tools.map(tool => tool.name), ["find_projects", "find_sessions", "create_session", "send_message"]);
  assert.equal(new Set(f.tools.map(tool => tool.options.permission)).size, 4);
  for (const tool of f.tools) assert.equal(tool.options.codemode, tool.name !== "send_message",
    "Sending is a direct tool; discovery and creation remain in Code Mode");
  for (const tool of f.tools) assert.equal(tool.input.additionalProperties, false);
  const send = f.tools.find(tool => tool.name === "send_message")!;
  assert.equal(send.input.properties.sender, undefined);
  assert.equal(send.input.properties.senderTitle, undefined);
  assert.deepEqual(send.input.properties.delivery.enum, ["steer", "queue", "fyi"]);
});
test("every tool parameter has help that remains useful when the main description is abbreviated", async () => {
  const f = await registered();
  const check = (schema: any, path: string) => {
    for (const [name, value] of Object.entries(schema.properties ?? {})) {
      const property = value as { description?: string; properties?: unknown };
      assert.ok(property.description && property.description.length > 15, `Missing parameter help: ${path}.${name}`);
      if (property.properties) check(property, `${path}.${name}`);
    }
  };
  for (const tool of f.tools) check(tool.input, tool.name);
  const create = f.tools.find(tool => tool.name === "create_session")!.input.properties;
  assert.match(create.project.description, /actual current directory/);
  assert.match(create.agent.description, /destination's default agent/);
  assert.match(create.worktree.description, /Include this to create a new worktree/);
  const send = f.tools.find(tool => tool.name === "send_message")!.input.properties;
  assert.match(send.delivery.description, /steer \(default\)/);
  assert.match(send.delivery.description, /without waking an idle session/);
  assert.match(send.text.description, /65,536 UTF-8 bytes/);
});
test("all four tools declare structured outputs and retain readable UI text without undefined fields", async () => {
  const f = await registered();
  f.sessions.get("ses_peer")!.title = "Peer review";
  const input: Record<string, unknown> = {
    find_projects: {}, find_sessions: { relationship: "roots" },
    create_session: { title: "Structured result" }, send_message: { sessionID: "ses_peer", text: "test", delivery: "fyi" },
  };
  for (const tool of f.tools) {
    assert.equal(tool.output.type, "object");
    assert.equal(tool.output.additionalProperties, false);
    const progress: unknown[] = [];
    const context = { ...call, progress: async (update: unknown) => { progress.push(update); } };
    const result = await tool.execute(input[tool.name], context);
    assert.equal(typeof result.output, "object");
    assert.notEqual(typeof result.output, "string");
    assert.equal(typeof result.content, "string");
    assert.ok(result.content.length > 10);
    assert.doesNotMatch(result.content, /^\s*\{/);
    assert.deepEqual(result.output, JSON.parse(JSON.stringify(result.output)), "Omit undefined properties before host schema validation");
    if (tool.name === "send_message") assert.deepEqual(progress, [{ title: "Sending message to Peer review" }]);
  }
  const find = f.tools.find(tool => tool.name === "find_sessions")!;
  assert.ok(find.output.properties.sessions.items.properties.lastExecutionAt);
  const props = find.input.properties;
  assert.deepEqual(props.relationship.enum, ["all", "roots", "siblings"]);
  assert.match(props.activeSince.description, /Viewing or editing session metadata does not count/);
});
test("native child work remains native; hook authorizes it and persists only newly created/continued channels", async () => {
  const f = await registered();
  f.sessions.set("existing", session("existing", { parentID: call.sessionID, agent: "explore" }));
  const event = { ...call, tool: "subagent", input: { agent: "explore", prompt: "task", background: true } };
  await f.hooks.get("tool/execute.before")!(event);
  assert.equal(f.admissions.length, 0, "Linklet must not dispatch the native task itself");
  f.sessions.set("new-child", session("new-child", { parentID: call.sessionID, agent: "explore" }));
  const original = { content: "Native background result" };
  const after = { ...event, status: "completed", result: original };
  await f.hooks.get("tool/execute.after")!(after);
  assert.equal(after.result, original, "Native result must remain untouched");
  const sender = { sessionID: call.sessionID, agentID: call.agent };
  assert.ok(await f.linklet.channels.has(sender, { sessionID: "new-child", agentID: "explore" }));
  assert.equal(await f.linklet.channels.has(sender, { sessionID: "existing", agentID: "explore" }), false);
});
test("native continuation reuses an established channel and does not resend final results", async () => {
  const f = await registered();
  const child = session("child", { parentID: call.sessionID, agent: "explore" });
  f.sessions.set(child.id, child);
  const sender = { sessionID: call.sessionID, agentID: call.agent }, recipient = { sessionID: child.id, agentID: "explore" };
  await f.linklet.channels.establish(sender, recipient);
  const event = { ...call, tool: "subagent", input: { sessionID: child.id, agent: "explore", prompt: "correction" } };
  await f.hooks.get("tool/execute.before")!(event);
  assert.equal((f.checks.at(-1)!.metadata!["linklet.v1"] as { requiresApproval: boolean }).requiresApproval, false);
  await f.hooks.get("tool/execute.after")!({ ...event, status: "completed", result: { content: "Native result" } });
  assert.equal(f.admissions.length, 0);
});
test("a foreground native child can communicate before its parent's tool returns", async () => {
  const f = await registered();
  await f.hooks.get("tool/execute.before")!({ ...call, tool: "subagent", input: { agent: "explore" } });
  f.sessions.set("child", session("child", { parentID: call.sessionID, agent: "explore" }));
  await f.linklet.send({ sessionID: call.sessionID, text: "Blocker", delivery: "fyi" }, {
    ...call, sessionID: "child", agent: "explore", id: "child-call",
  });
  const check = f.checks.findLast(check => check.action === "linklet.cross_agent")!;
  assert.equal((check.metadata!["linklet.v1"] as { requiresApproval: boolean }).requiresApproval, false);
  f.sessions.set("unrelated", session("unrelated", { agent: "explore" }));
  await f.linklet.send({ sessionID: call.sessionID, text: "Unrelated", delivery: "fyi" }, {
    ...call, sessionID: "unrelated", agent: "explore", id: "unrelated-call",
  });
  assert.equal((f.checks.at(-1)!.metadata!["linklet.v1"] as { requiresApproval: boolean }).requiresApproval, true);
});
test("native continuations persist the newly authorized agent and reuse its channel for follow-ups", async () => {
  const f = await registered();
  f.agents.push(agent("general", { mode: "subagent" }));
  f.sessions.set("child", session("child", { parentID: call.sessionID, agent: "explore" }));
  const sender = { sessionID: call.sessionID, agentID: call.agent };
  await f.linklet.channels.establish(sender, { sessionID: "child", agentID: "explore" });
  const event = { ...call, tool: "subagent", input: { sessionID: "child", agent: "general", prompt: "New task" } };
  await f.hooks.get("tool/execute.before")!(event);
  await f.hooks.get("permission/evaluate")!({ sessionID: call.sessionID, agent: call.agent,
    action: "subagent", resources: ["general"], effect: "allow",
    source: { type: "tool", messageID: call.messageID, id: call.id } });
  f.sessions.set("child", session("child", { parentID: call.sessionID, agent: "general" }));
  await f.hooks.get("tool/execute.after")!({ ...event, status: "completed", result: { content: "Native result" } });
  assert.ok(await f.linklet.channels.has(sender, { sessionID: "child", agentID: "general" }));
  await f.linklet.send({ sessionID: "child", text: "Follow-up", delivery: "fyi" }, call);
  assert.equal((f.checks.at(-1)!.metadata!["linklet.v1"] as { requiresApproval: boolean }).requiresApproval, false);
});
test("a rejected native agent switch does not authorize a new pending channel", async () => {
  const f = await registered();
  f.agents.push(agent("general", { mode: "subagent" }));
  f.sessions.set("child", session("child", { parentID: call.sessionID, agent: "explore" }));
  const event = { ...call, tool: "subagent", input: { sessionID: "child", agent: "general" } };
  await f.hooks.get("tool/execute.before")!(event);
  f.deny("linklet.cross_agent");
  await assert.rejects(f.hooks.get("permission/evaluate")!({ sessionID: call.sessionID, agent: call.agent,
    action: "subagent", resources: ["general"], effect: "allow",
    source: { type: "tool", messageID: call.messageID, id: call.id } }), /denied/);
  const sender = { sessionID: call.sessionID, agentID: call.agent };
  // Parentage alone must not turn the rejected switch into a channel.
  f.sessions.set("child", session("child", { parentID: call.sessionID, agent: "general" }));
  await f.linklet.recordNativeChild(f.sessions.get("child")!);
  assert.equal(await f.linklet.channels.has(sender, { sessionID: "child", agentID: "general" }), false);
});
test("native permission hook catches changed or otherwise unobserved target agent IDs", async () => {
  const f = await registered();
  const event = { sessionID: call.sessionID, agent: call.agent, action: "subagent", resources: ["explore"],
    source: { type: "tool", messageID: call.messageID, id: call.id }, effect: "allow" };
  await f.hooks.get("permission/evaluate")!(event);
  assert.equal(f.checks.at(-1)!.action, "linklet.cross_agent");
});
test("native failures retain their original error while recording known successful child creation", async () => {
  const f = await registered();
  const event = { ...call, tool: "subagent", input: { agent: "explore" } };
  await f.hooks.get("tool/execute.before")!(event);
  f.sessions.set("failed-child", session("failed-child", { parentID: call.sessionID, agent: "explore" }));
  const failure = { ...event, status: "error", error: { message: "Native model failed" } };
  await f.hooks.get("tool/execute.after")!(failure);
  assert.equal(failure.error.message, "Native model failed");
  assert.ok(await f.linklet.channels.has({ sessionID: call.sessionID, agentID: call.agent }, { sessionID: "failed-child", agentID: "explore" }));
});
test("context provides parent and creator separately, omits own ID, and keeps provenance guidance localized", async () => {
  const f = await registered();
  f.sessions.set(call.sessionID, session(call.sessionID, { parentID: "native-parent" }));
  f.storage.set(`v1/creator/${call.sessionID}`, "independent-creator");
  const event = { sessionID: call.sessionID, system: [] as { text: string }[] };
  await f.hooks.get("session/context")!(event);
  const text = event.system.map(part => part.text).join("\n");
  assert.match(text, /native-parent/);
  assert.match(text, /independent-creator/);
  assert.match(text, /not its parent/);
  assert.equal(text.includes(call.sessionID), false);
});
