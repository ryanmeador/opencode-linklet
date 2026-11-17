import { test } from "node:test";
import assert from "node:assert/strict";
import { agent, call, fixture } from "./helpers.js";

test("agent lookup retries a temporarily empty registry, not a populated one", async t => {
  const f = fixture();
  let reads = 0;
  t.mock.method(f.client.agent, "list", async () => ({ location: { directory: "/one" },
    data: ++reads < 3 ? [] : [agent("build")] }));
  assert.equal((await f.linklet.agents("/one"))[0].id, "build");
  assert.equal(reads, 3);
  await f.linklet.agents("/one");
  assert.equal(reads, 4, "Populated registries are returned immediately");
});
test("empty agent registries have a bounded retry budget", async t => {
  const f = fixture();
  const read = t.mock.method(f.client.agent, "list", async () => ({ location: { directory: "/one" }, data: [] }));
  assert.deepEqual(await f.linklet.agents("/one"), []);
  assert.equal(read.mock.callCount(), 41);
});
test("cancellation during registry activation stops before creating resources", async t => {
  const f = fixture(), controller = new AbortController();
  const read = t.mock.method(f.client.agent, "list", async () => {
    controller.abort();
    return { location: { directory: "/one" }, data: [] };
  });
  await assert.rejects(f.linklet.create({}, { ...call, signal: controller.signal }), { name: "AbortError" });
  assert.equal(read.mock.callCount(), 1);
  assert.equal(f.resources.length, 0);
});
test("agent lookup errors are not retried", async t => {
  const f = fixture();
  const read = t.mock.method(f.client.agent, "list", async () => { throw new Error("offline"); });
  await assert.rejects(f.linklet.agents("/one"), /offline/);
  assert.equal(read.mock.callCount(), 1);
});
