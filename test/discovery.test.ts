import { test } from "node:test";
import assert from "node:assert/strict";
import { lastExecutionTime, parseActiveSince, MAX_SCANNED_SESSIONS } from "../src/discovery.js";
import { Linklet } from "../src/linklet.js";
import { actions } from "../src/policy.js";
import { call, fixture, session } from "./helpers.js";

const cutoff = "2026-11-07T12:00:00Z";
const since = Date.parse(cutoff);
test("discovery includes checkout HEAD once per returned directory and refreshes on each call", async t => {
  const f = fixture(), sha = "a".repeat(40);
  const read = t.mock.method(f.linklet, "checkoutCommit", async () => sha);
  const page = await f.linklet.findSessions({}, call);
  assert.equal(page.sessions.length, 2);
  assert.ok(page.sessions.every(item => item.commitSHA === sha));
  assert.equal(read.mock.callCount(), 1, "Shared checkout is inspected once");
  const single = await f.linklet.findSessions({ sessionID: "ses_peer" }, call);
  assert.equal(single.sessions[0].commitSHA, sha);
  assert.equal(read.mock.callCount(), 2, "Single-ID lookup gets fresh checkout state");
});
test("discovery omits unavailable HEAD and does not inspect unauthorized directories", async t => {
  const f = fixture();
  const read = t.mock.method(f.linklet, "checkoutCommit", async () => undefined);
  assert.ok((await f.linklet.findSessions({}, call)).sessions.every(item => !("commitSHA" in item)));
  read.mock.resetCalls();
  f.sessions.set("foreign", session("foreign", { projectID: "project_two", location: { directory: "/two" } }));
  f.deny(actions.discover);
  await assert.rejects(f.linklet.findSessions({ sessionID: "foreign" }, call));
  assert.equal(read.mock.callCount(), 0);
});
const ids = (page: { sessions: { sessionID: string }[] }) => page.sessions.map(item => item.sessionID).sort();

test("execution timestamps use start/end only, never creation, viewing or generic updates", async () => {
  const f = fixture();
  const s = session("timestamps", { time: { created: since, updated: since + 4, viewed: since + 8, busy: since - 100, idle: since - 50 } });
  assert.equal(lastExecutionTime(s), since - 50);
  assert.equal((await f.linklet.summary(s)).lastExecutionAt, new Date(since - 50).toISOString());
  s.time.busy = since + 20;
  assert.equal(lastExecutionTime(s), since + 20);
  delete s.time.busy; delete s.time.idle;
  assert.equal(lastExecutionTime(s), undefined);
  assert.equal("lastExecutionAt" in await f.linklet.summary(s), false);
  s.time.busy = NaN; s.time.idle = Infinity;
  assert.equal(lastExecutionTime(s), undefined);
  s.time.busy = 0;
  assert.equal((await f.linklet.summary(s)).lastExecutionAt, "1970-01-01T00:00:00.000Z");
});

test("recent activity includes execution boundaries at the cutoff, not unrelated updates", async () => {
  const f = fixture();
  f.sessions.set("recent-start", session("recent-start", { time: { created: 1, updated: 1, busy: since } }));
  f.sessions.set("recent-end", session("recent-end", { time: { created: 1, updated: 1, busy: 1, idle: since + 1 } }));
  f.sessions.set("viewed-only", session("viewed-only", { time: { created: 1, updated: since + 100, viewed: since + 100, idle: since - 1 } }));
  f.sessions.set("created-only", session("created-only", { time: { created: since + 1, updated: since + 1 } }));
  assert.deepEqual(ids(await f.linklet.findSessions({ activeSince: cutoff }, call)), ["recent-end", "recent-start"]);
});

test("ongoing executions match recent searches even when started earlier or timestamps are unknown", async () => {
  const f = fixture();
  f.sessions.set("old-running", session("old-running", { time: { created: 1, updated: 1, busy: since - 100000 } }));
  f.sessions.set("unknown-running", session("unknown-running"));
  f.state.active = { "old-running": { type: "running" }, "unknown-running": { type: "running" } };
  const page = await f.linklet.findSessions({ activeSince: cutoff }, call);
  assert.deepEqual(ids(page), ["old-running", "unknown-running"]);
  assert.equal(page.sessions.find(item => item.sessionID === "old-running")!.lastExecutionAt, new Date(since - 100000).toISOString());
  assert.equal("lastExecutionAt" in page.sessions.find(item => item.sessionID === "unknown-running")!, false);
  assert.deepEqual(ids(await f.linklet.findSessions({ activeSince: "9999-01-01T00:00:00Z" }, call)), []);
});

test("old blocked sessions and missing status data do not prove recent execution", async () => {
  const f = fixture();
  f.state.active = { ses_peer: { type: "running" } };
  f.state.pending = [{}];
  assert.deepEqual(ids(await f.linklet.findSessions({ activeSince: cutoff }, call)), []);
  f.state.pending = [];
  f.client.session.active = async () => { throw new Error("snapshot unavailable"); };
  assert.deepEqual(ids(await f.linklet.findSessions({ activeSince: cutoff }, call)), []);
  f.sessions.set("known-recent", session("known-recent", { time: { created: 1, updated: 1, busy: since + 1 } }));
  const page = await f.linklet.findSessions({ activeSince: cutoff }, call);
  assert.deepEqual(ids(page), ["known-recent"]);
  assert.equal(page.sessions[0].activity, "unknown");
});

test("cutoffs require valid explicit-timezone ISO timestamps and normalize equivalent offsets", () => {
  assert.equal(parseActiveSince(cutoff), parseActiveSince("2026-11-07T13:00:00+01:00"));
  assert.equal(parseActiveSince(undefined), undefined);
  for (const value of ["yesterday", "2026-11-07", "2026-11-07T12:00:00", "2026-02-30T12:00:00Z", "2026-11-07T24:00:00Z", "invalid"])
    assert.throws(() => parseActiveSince(value), /ISO 8601 timestamp with a timezone/);
});

test("root and sibling filters use native parentage, not creator relationships", async () => {
  const f = fixture();
  f.sessions.set("child-a", session("child-a", { parentID: call.sessionID }));
  f.sessions.set("child-b", session("child-b", { parentID: call.sessionID }));
  f.sessions.set("unrelated-child", session("unrelated-child", { parentID: "another-parent" }));
  f.storage.set("v1/creator/ses_peer", call.sessionID);
  assert.deepEqual(ids(await f.linklet.findSessions({ relationship: "roots" }, call)), [call.sessionID, "ses_peer"].sort());
  assert.deepEqual(ids(await f.linklet.findSessions({ relationship: "siblings" }, call)), ["ses_peer"]);
  assert.deepEqual(ids(await f.linklet.findSessions({ relationship: "siblings" }, { ...call, sessionID: "child-a" })), ["child-b"]);
  assert.ok(f.lists.some(input => input.parentID === null));
  assert.ok(f.lists.some(input => input.parentID === call.sessionID));
});

test("filtering crosses native page boundaries, fills pages, and uses short scope-bound cursors", async () => {
  const f = fixture();
  for (let i = 0; i < 8; i++) f.sessions.set(`item-${i}`, session(`item-${i}`, {
    time: { created: 1, updated: 1, busy: i % 2 === 0 ? since : 1 },
  }));
  const filter = { activeSince: cutoff, relationship: "roots" as const, limit: 2 };
  const first = await f.linklet.findSessions(filter, call);
  assert.deepEqual(ids(first), ["item-0", "item-2"]);
  assert.equal(first.nextCursor!.length, 24);
  const second = await new Linklet(f.ctx, f.client).findSessions({ ...filter, cursor: first.nextCursor! }, call);
  assert.deepEqual(ids(second), ["item-4", "item-6"]);
  assert.equal(second.nextCursor, null, "Do not return a token for an empty last page");
  for (const changes of [{ relationship: "all" as const }, { activeSince: "2026-11-08T00:00:00Z" }, { search: "another" }, { all: true }])
    await assert.rejects(f.linklet.findSessions({ ...filter, ...changes, cursor: first.nextCursor! }, call), /different search/);
});

test("a short final native page and an exact-full final page both have no phantom next page", async () => {
  const f = fixture();
  for (const limit of [2, 5]) {
    const page = await f.linklet.findSessions({ limit }, call);
    assert.equal(page.sessions.length, 2);
    assert.equal(page.nextCursor, null);
  }
});

test("a shared active snapshot avoids one global status request per session", async () => {
  const f = fixture();
  let snapshots = 0;
  f.client.session.active = async () => { snapshots++; return f.state.active; };
  const page = await f.linklet.findSessions({}, call);
  assert.equal(page.sessions.length, 2);
  assert.equal(snapshots, 1);
});
test("execution boundaries newer than the shared snapshot invalidate its running/idle inference", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  for (const wasRunning of [false, true]) {
    now = 1000;
    const f = fixture();
    f.sessions.get("ses_peer")!.time.busy = 500;
    f.state.active = wasRunning ? { ses_peer: { type: "running" } } : {};
    const list = f.ctx.session.list;
    f.ctx.session.list = async (...args) => {
      now = 2000;
      if (wasRunning) f.sessions.get("ses_peer")!.time.idle = now;
      else f.sessions.get("ses_peer")!.time.busy = now;
      return list(...args);
    };
    const page = await f.linklet.findSessions({}, call);
    const changed = page.sessions.find(item => item.sessionID === "ses_peer")!;
    assert.equal(changed.activity, "unknown", "A stale snapshot must not override a newer execution boundary");
    assert.equal(changed.lastExecutionAt, "1970-01-01T00:00:02.000Z");
  }
});
test("the stale-snapshot guard also covers execution starting while the status request is in flight", async t => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  f.client.session.active = async () => {
    // The server captured an empty active set before execution started, but
    // the request only completes after the start event is visible in metadata.
    now = 2000;
    f.sessions.get("ses_peer")!.time.busy = now;
    return {};
  };
  const page = await f.linklet.findSessions({}, call);
  assert.equal(page.sessions.find(item => item.sessionID === "ses_peer")!.activity, "unknown");
});

test("sibling cursors cannot be reused by a different caller or after a parent change", async () => {
  const f = fixture();
  f.sessions.set("third", session("third"));
  const first = await f.linklet.findSessions({ relationship: "siblings", limit: 1 }, call);
  assert.ok(first.nextCursor);
  await assert.rejects(f.linklet.findSessions({ relationship: "siblings", cursor: first.nextCursor! }, { ...call, sessionID: "ses_peer" }), /different search/);
  f.sessions.get(call.sessionID)!.parentID = "changed-parent";
  await assert.rejects(f.linklet.findSessions({ relationship: "siblings", cursor: first.nextCursor! }, call), /different search/);
});

test("large sparse searches are bounded and explicitly offer continuation rather than a false completion", async () => {
  const f = fixture();
  for (let i = 0; i < MAX_SCANNED_SESSIONS + 10; i++) f.sessions.set(`old-${i}`, session(`old-${i}`));
  const first = await f.linklet.findSessions({ activeSince: cutoff }, call);
  assert.deepEqual(first.sessions, []);
  assert.equal("scanLimitReached" in first && first.scanLimitReached, true);
  assert.ok(first.nextCursor);
  const last = await f.linklet.findSessions({ activeSince: cutoff, cursor: first.nextCursor! }, call);
  assert.equal(last.nextCursor, null);
  assert.equal("scanLimitReached" in last, false);
});

test("single-ID lookup returns timestamps while preserving override semantics and discovery approval", async () => {
  const f = fixture();
  f.sessions.set("foreign", session("foreign", { projectID: "project_two", time: { created: 1, updated: 1, idle: since } }));
  const page = await f.linklet.findSessions({ sessionID: "foreign", activeSince: "ignored", relationship: "siblings" }, call);
  assert.equal(page.sessions[0].lastExecutionAt, new Date(since).toISOString());
  assert.equal(f.checks.at(-1)!.action, actions.discover);
  f.deny(actions.discover);
  await assert.rejects(f.linklet.findSessions({ all: true, activeSince: cutoff }, call), /denied/);
});
