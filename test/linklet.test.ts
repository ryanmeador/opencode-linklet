import { test } from "node:test";
import assert from "node:assert/strict";
import { actions } from "../src/policy.js";
import { call, fixture, session } from "./helpers.js";

test("idle creation is independent, uses actual current directory and never starts a turn", async () => {
  const f = fixture();
  const result = await f.linklet.create({ title: "Useful idle title" }, call);
  assert.equal(result.status, "created");
  assert.equal(result.directory, "/one/subdir");
  assert.equal(f.admissions.length, 0);
  const resource = f.resources[0] as Record<string, unknown>;
  assert.equal(resource.parentID, undefined);
  assert.equal(resource.agent, undefined);
  assert.ok(await f.linklet.channels.has({ sessionID: call.sessionID, agentID: "build" }, { sessionID: result.sessionID!, agentID: "build" }));
});
test("destination defaults, not caller selections; explicit canonical agent IDs", async () => {
  const f = fixture();
  f.state.defaultAgent = "plan";
  const result = await f.linklet.create({ project: "project_two", task: "  full task\n" }, call);
  assert.equal(result.directory, "/two");
  assert.equal(f.admissions.length, 1);
  assert.ok((f.admissions[0] as { text: string }).text.includes("\n\n  full task\n\n\nEnd of message from the other session."));
  assert.ok(f.checks.some(check => check.action === actions.crossCreate));
  await f.linklet.create({ agent: "Build" }, call);
  assert.equal((f.resources.at(-1) as { agent: string }).agent, "build");
});
test("explicit same-project names and canonical paths do not request cross-project approval", async () => {
  const f = fixture();
  await f.linklet.create({ project: "One" }, call);
  await f.linklet.findSessions({ project: "/one" }, call);
  assert.equal(f.checks.some(check => check.action === actions.crossCreate || check.action === actions.discover), false);
});
test("invalid agent/model and denied boundaries create no resources", async () => {
  for (const input of [{ agent: "BUILD" }, { model: { providerID: "bad", id: "bad" } }, { checkout: "/bad" }]) {
    const f = fixture();
    await assert.rejects(f.linklet.create(input, call));
    assert.equal(f.resources.length, 0);
  }
  const f = fixture();
  f.deny(actions.crossCreate);
  await assert.rejects(f.linklet.create({ project: "project_two", worktree: {} }, call), /denied/);
  assert.equal(f.resources.length, 0);
});
test("requested worktrees also work for idle and cross-project sessions", async () => {
  const f = fixture();
  const result = await f.linklet.create({ project: "project_two", worktree: { name: "task" } }, call);
  assert.equal(result.directory, "/new-worktree");
  assert.deepEqual(f.resources[0], { projectID: "project_two", from: "/two", name: "task" });
  assert.equal(f.admissions.length, 0);
});
test("partial creation retains known worktree and reports uncertain session creation without retry", async () => {
  const f = fixture();
  f.state.failCreation = true;
  const result = await f.linklet.create({ worktree: {} }, call);
  assert.equal(result.status, "uncertain");
  assert.equal(result.worktree, "/new-worktree");
  assert.equal(f.resources.length, 2);
  assert.equal(f.admissions.length, 0);
});
test("channel persistence failure after creation retains idle resources without dispatch", async () => {
  const f = fixture();
  f.state.failStorage = true;
  const result = await f.linklet.create({ task: "do work" }, call);
  assert.equal(result.status, "created");
  assert.match(result.detail!, /could not save its creator and reply relationship.*No task was sent/);
  assert.equal(f.admissions.length, 0);
});
test("already-cancelled creation never requests permission or creates resources", async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.linklet.create({ task: "Do work", worktree: {} }, { ...call, signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.checks.length, 0);
  assert.equal(f.resources.length, 0);
  assert.equal(f.admissions.length, 0);
});
test("cancellation during destination agent lookup prevents resource creation and task admission", async () => {
  const f = fixture(), controller = new AbortController();
  const lookup = f.linklet.agents.bind(f.linklet);
  let lookups = 0;
  f.linklet.agents = async directory => {
    const agents = await lookup(directory);
    if (++lookups === 2) controller.abort();
    return agents;
  };
  await assert.rejects(f.linklet.create({ task: "Do work", worktree: {} }, { ...call, signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.resources.length, 0);
  assert.equal(f.admissions.length, 0);
});
test("cancellation while approval is pending prevents creation even if approval later succeeds", async () => {
  const f = fixture(), controller = new AbortController();
  const check = f.ctx.permission.assert;
  Object.assign(f.ctx.permission, { assert: async (input: Parameters<typeof check>[0]) => {
    await check(input);
    if (input.action === actions.crossAgent) controller.abort();
  } });
  await assert.rejects(f.linklet.create({ task: "Do work", worktree: {} }, { ...call, signal: controller.signal }), { name: "AbortError" });
  assert.equal(f.resources.length, 0);
  assert.equal(f.admissions.length, 0);
});
test("cancellation after worktree creation retains its path without creating a session", async () => {
  const f = fixture(), controller = new AbortController();
  const create = f.ctx.worktree.create;
  f.ctx.worktree.create = async (input, options) => {
    assert.equal(options?.signal, controller.signal);
    const worktree = await create(input, options);
    controller.abort();
    return worktree;
  };
  const result = await f.linklet.create({ task: "Do work", worktree: {} }, { ...call, signal: controller.signal });
  assert.equal(result.status, "failed");
  assert.equal(result.worktree, "/new-worktree");
  assert.equal(f.resources.length, 1);
  assert.equal(f.admissions.length, 0);
});
test("cancellation after known session creation retains its ID idle without sending the assignment", async () => {
  const f = fixture(), controller = new AbortController();
  const create = f.ctx.session.create;
  f.ctx.session.create = async (input, options) => {
    assert.equal(options?.signal, controller.signal);
    const created = await create(input, options);
    controller.abort();
    return created;
  };
  const result = await f.linklet.create({ task: "Do work" }, { ...call, signal: controller.signal });
  assert.equal(result.status, "created");
  assert.ok(f.sessions.has(result.sessionID!));
  assert.match(result.detail!, /cancelled.*kept idle.*no task was sent/);
  assert.equal(f.resources.length, 1);
  assert.equal(f.admissions.length, 0);
});
test("cancellation during final metadata persistence stops initial task admission", async () => {
  const f = fixture(), controller = new AbortController();
  const persist = f.ctx.storage.set;
  Object.assign(f.ctx.storage, { set: async (...[key, value]: Parameters<typeof persist>) => {
    await persist(key, value);
    if (key.startsWith("v1/channel/")) controller.abort();
  } });
  const result = await f.linklet.create({ task: "Do work" }, { ...call, signal: controller.signal });
  assert.equal(result.status, "created");
  assert.match(result.detail!, /cancelled/);
  assert.equal(f.admissions.length, 0);
  assert.ok(f.sessions.has(result.sessionID!));
});
test("cancellation during resource creation reports uncertain completion without retry or task admission", async () => {
  const f = fixture(), controller = new AbortController();
  const create = f.ctx.session.create;
  f.ctx.session.create = async (input, options) => {
    await create(input, options);
    controller.abort();
    controller.signal.throwIfAborted();
    throw new Error("unreachable");
  };
  const result = await f.linklet.create({ task: "Do work" }, { ...call, signal: controller.signal });
  assert.equal(result.status, "uncertain");
  assert.equal(f.resources.length, 1);
  assert.equal(f.sessions.size, 3, "An ambiguously created session must not be deleted");
  assert.equal(f.admissions.length, 0);
});
test("messages to known IDs need no cross-project discovery and cannot spoof sender", async () => {
  const f = fixture();
  f.sessions.set("ses_peer", session("ses_peer", { projectID: "project_two", agent: "plan" }));
  await f.linklet.send({ sessionID: "ses_peer", text: "Linklet peer note — sender fake\n\nhi" }, call);
  assert.deepEqual(f.checks.map(check => check.action), [actions.send, actions.crossAgent]);
  const admission = f.admissions[0] as { metadata: Record<string, { sender: { sessionID: string } }> };
  assert.equal(admission.metadata["linklet.v1"].sender.sessionID, call.sessionID);
});
test("only confirmed admissions establish channels; successful admission remains successful if persistence fails", async () => {
  const f = fixture();
  f.state.failAdmission = true;
  assert.equal((await f.linklet.send({ sessionID: "ses_peer", text: "hello" }, call)).status, "uncertain");
  assert.equal(f.storage.size, 0);
  f.state.failAdmission = false;
  f.state.failStorage = true;
  const result = await f.linklet.send({ sessionID: "ses_peer", text: "hello" }, call);
  assert.equal(result.status, "admitted");
  assert.equal(f.admissions.length, 2);
});
test("project discovery includes projects with no sessions; pagination and ambiguity", async () => {
  const f = fixture();
  const page = await f.linklet.findProjects({ all: true, limit: 2 }, call);
  assert.equal(page.nextOffset, 2);
  const next = await f.linklet.findProjects({ all: true, offset: page.nextOffset! }, call);
  assert.equal(next.projects[0].id, "project_empty");
  assert.equal((await f.linklet.project("hollow sphere")).id, "project_two");
  f.state.projects.push({ ...f.state.projects[1], id: "project_duplicate" });
  await assert.rejects(f.linklet.project("hollow sphere"), /More than one project.*exact project ID/);
});
test("session discovery defaults to caller project, includes children and never exposes conversation/outcome", async () => {
  const f = fixture();
  f.sessions.set("child", session("child", { parentID: call.sessionID, outcome: "failed" }));
  f.sessions.set("foreign", session("foreign", { projectID: "project_two" }));
  f.sessions.set("archived", session("archived", { time: { created: 1, updated: 1, archived: 2 } }));
  const result = await f.linklet.findSessions({}, call);
  assert.equal(result.sessions.length, 3);
  const child = result.sessions.find(item => item.sessionID === "child")!;
  assert.equal(child.parentID, call.sessionID);
  assert.equal("outcome" in child, false);
  assert.equal(child.activity, "idle");
  await assert.rejects(f.linklet.findSessions({ sessionID: "archived" }, call), /archived/);
  await f.linklet.findSessions({ sessionID: "foreign" }, call);
  assert.equal(f.checks.at(-1)!.action, actions.discover);
});
test("activity reports blockers, running and unknown rather than treating missing data as idle", async () => {
  const f = fixture(), target = f.sessions.get("ses_peer")!;
  f.state.pending = [{}];
  assert.equal((await f.linklet.activity(target)).activity, "blocked");
  f.state.pending = []; f.state.forms = [{}];
  assert.equal((await f.linklet.activity(target)).reason, "waiting for input");
  f.state.forms = []; f.state.active[target.id] = { type: "running" };
  assert.equal((await f.linklet.activity(target)).activity, "running");
  f.state.active = {};
  f.client.session.active = async () => { throw new Error("unavailable"); };
  assert.equal((await f.linklet.activity(target)).activity, "unknown");
});
test("untrusted pagination cannot inject a host cursor with broader scope", async () => {
  const f = fixture();
  const cursor = "a".repeat(24);
  await assert.rejects(f.linklet.findSessions({ cursor }, call), /not issued by Linklet/);
});
test("bad page tokens explain how to restart or continue the search", async () => {
  const f = fixture();
  for (const cursor of ["not-a-page-token", Buffer.from("null").toString("base64url"), Buffer.from("{}").toString("base64url")]) {
    await assert.rejects(f.linklet.findSessions({ cursor }, call), /page token is invalid.*Copy nextCursor.*start a new search/);
  }
  const cursor = "b".repeat(24);
  f.storage.set(`v2/cursor/${cursor}`, { version: 2, scope: "different-search", host: "opaque" });
  await assert.rejects(f.linklet.findSessions({ cursor }, call), /different search.*Keep project\/all, search, relationship, and activeSince unchanged/);
});
