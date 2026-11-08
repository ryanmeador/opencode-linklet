import { test } from "node:test";
import assert from "node:assert/strict";
import { actions, Channels, defaultAgent, explicitGrant, match, needsCrossAgent, selectAgent } from "../src/policy.js";
import { agent, call, fixture } from "./helpers.js";

test("identity policy uses IDs, not names or capability inference", () => {
  for (const [from, to, expected] of [["build", "build", false], ["build", "plan", false], ["plan", "build", true], ["review", "build", true]] as const) {
    assert.equal(needsCrossAgent({ sessionID: "a", agentID: from }, { sessionID: "b", agentID: to }, false), expected);
    assert.equal(needsCrossAgent({ sessionID: "a", agentID: from }, { sessionID: "b", agentID: to }, true), false);
  }
});
test("agent selection: exact ID, exact unique display name, availability and primary eligibility", () => {
  const agents = [agent("build"), agent("other", { name: "build" }), agent("plan"), agent("child", { mode: "subagent" })];
  assert.equal(selectAgent(agents, "build").id, "build");
  assert.equal(selectAgent(agents, "Build").id, "build");
  assert.throws(() => selectAgent([...agents, agent("copy", { name: "Build" })], "Build"), /More than one.*exact agent ID/);
  assert.throws(() => selectAgent(agents, "BUILD"), /No agent matches.*Available agents/);
  assert.throws(() => selectAgent(agents, "child"), /cannot be used for an independent session/);
  assert.equal(defaultAgent(agents, "plan").id, "plan");
  assert.equal(defaultAgent(agents, "missing").id, "build");
  assert.equal(defaultAgent([agent("custom")]).id, "custom");
});
test("wildcards are literal except * and ?; general host grants are not preauthorization", () => {
  assert.equal(match("linklet.*", actions.crossAgent), true);
  assert.equal(match("literal[0]", "literal[0]"), true);
  assert.equal(match("literal[0]", "literal0"), false);
  assert.equal(explicitGrant([{ action: "*", resource: "*", effect: "allow" }], actions.crossAgent, ["*"]), false);
  assert.equal(explicitGrant([{ action: "linklet.*", resource: "*", effect: "allow" }], actions.crossAgent, ["*"]), true);
});
test("channels persist bidirectionally across reloads and are bound to agent IDs", async () => {
  const values = new Map();
  const store = { get: async (key: string) => values.get(key), set: async (key: string, value: unknown) => { values.set(key, value); } };
  const a = { sessionID: "a", agentID: "plan" }, b = { sessionID: "b", agentID: "build" };
  await new Channels(store).establish(a, b);
  const reloaded = new Channels(store);
  assert.equal(await reloaded.has(b, a), true);
  assert.equal(await reloaded.has({ ...a, agentID: "review" }, b), false);
  await Promise.all(Array.from({ length: 20 }, () => reloaded.establish(a, b)));
  assert.equal(values.size, 1);
});
test("default ask escalates wildcard allows, honors explicit grants and project-scoped saved approvals", async () => {
  const f = fixture();
  const event = { sessionID: call.sessionID, agent: call.agent, action: actions.crossAgent, resources: ["*"], effect: "allow" as "allow" | "ask" | "deny" };
  await f.linklet.permissionHook(event);
  assert.equal(event.effect, "ask");
  f.state.permissions = [{ action: actions.crossAgent, resource: "*", effect: "allow" }];
  event.effect = "allow";
  await f.linklet.permissionHook(event);
  assert.equal(event.effect, "allow");
  f.state.permissions = [];
  f.state.saved.push({ action: actions.crossAgent, resource: "*", projectID: "project_one" });
  await f.linklet.permissionHook(event);
  assert.equal(event.effect, "allow");
});
test("approval prompts describe the requested operation without permission-engine jargon", async () => {
  const f = fixture();
  for (const [action, message] of [
    [actions.discover, "Allow Linklet to look up projects or sessions outside this project? Conversation history is not included."],
    [actions.crossCreate, "Allow Linklet to create a session in another project?"],
    [actions.crossAgent, "Allow Linklet to create or message a session that uses a different agent?"],
  ]) {
    const event = { sessionID: call.sessionID, agent: call.agent, action, resources: ["*"],
      effect: "allow" as "allow" | "ask" | "deny", message: "" };
    await f.linklet.permissionHook(event);
    assert.equal(event.effect, "ask");
    assert.equal(event.message, message);
  }
});
test("explicit asks for ordinary tools explain the operation without changing the permission decision", async () => {
  const f = fixture();
  for (const [action, description] of [
    [actions.projects, /list registered projects/], [actions.sessions, /session titles.*Conversation history is not included/],
    [actions.create, /independent session.*will not inherit this conversation/], [actions.send, /send a message/],
  ] as const) {
    const event = { sessionID: call.sessionID, agent: call.agent, action, resources: ["*"],
      effect: "ask" as "allow" | "ask" | "deny", message: "" };
    await f.linklet.permissionHook(event);
    assert.equal(event.effect, "ask");
    assert.match(event.message, description);
    event.effect = "allow"; event.message = "";
    await f.linklet.permissionHook(event);
    assert.equal(event.effect, "allow");
    assert.equal(event.message, "");
    event.effect = "deny"; event.message = "User-configured denial";
    await f.linklet.permissionHook(event);
    assert.equal(event.effect, "deny");
    assert.equal(event.message, "User-configured denial");
  }
});
test("explicit denials always win, even for an established channel", async () => {
  const f = fixture();
  await f.linklet.channels.establish({ sessionID: call.sessionID, agentID: "build" }, { sessionID: "ses_peer", agentID: "build" });
  f.deny(actions.crossAgent);
  await assert.rejects(f.linklet.send({ sessionID: "ses_peer", text: "hello" }, call), /denied/);
  assert.equal(f.admissions.length, 0);
});
test("channels bypass additional cross-agent asks, not send permissions", async () => {
  const f = fixture();
  const event = { sessionID: call.sessionID, action: actions.crossAgent, resources: ["*"], effect: "ask" as "allow" | "ask" | "deny",
    metadata: { "linklet.v1": { requiresApproval: false } } };
  await f.linklet.permissionHook(event);
  assert.equal(event.effect, "allow");
  f.deny(actions.send);
  await assert.rejects(f.linklet.send({ sessionID: "ses_peer", text: "hello" }, call), /denied/);
});
