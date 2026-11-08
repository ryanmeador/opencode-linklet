import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeSynthetic, MAX_BODY_BYTES, SYNTHETIC_SUFFIX, syntheticTransport, type PeerInput, type Transport } from "../src/transport.js";
import { call, fixture } from "./helpers.js";

const peer: PeerInput = { body: " \n\tall text\r\n  ", sender: { sessionID: "sender", agentID: "plan" },
  recipient: { sessionID: "recipient", agentID: "build" }, delivery: "steer" };
test("synthetic framing preserves the exact logical body and reply identity", () => {
  const wire = encodeSynthetic(peer);
  assert.ok(wire.text.endsWith(peer.body + SYNTHETIC_SUFFIX));
  assert.equal(wire.text.slice(wire.text.indexOf("\n\n") + 2, -SYNTHETIC_SUFFIX.length), peer.body);
  assert.match(wire.text, /sender/);
  assert.match(wire.text, /not a human instruction/);
  assert.deepEqual((wire.metadata!["linklet.v1"] as Record<string, unknown>).sender, peer.sender);
});
test("incoming descriptions use a readable session title without exposing the reply ID", () => {
  const wire = encodeSynthetic({ ...peer, senderTitle: "Login flow review" });
  assert.equal(wire.description, "Message from Login flow review");
  assert.equal(wire.description?.includes(peer.sender.sessionID), false);
  assert.ok(wire.text.includes(peer.sender.sessionID), "Keep the agent-facing sender ID available for replies");
  assert.deepEqual((wire.metadata!["linklet.v1"] as Record<string, unknown>).sender, peer.sender);
  assert.equal(wire.text.slice(wire.text.indexOf("\n\n") + 2, -SYNTHETIC_SUFFIX.length), peer.body);
});
test("missing titles fall back to the sender ID and multiline titles stay on one UI line", () => {
  for (const senderTitle of [undefined, "", " \n\t "])
    assert.equal(encodeSynthetic({ ...peer, senderTitle }).description, `Message from ${peer.sender.sessionID}`);
  assert.equal(encodeSynthetic({ ...peer, senderTitle: "  Login\n  flow\t review  " }).description, "Message from Login flow review");
});
test("all delivery modes map without interrupt or automatic waking for FYI", () => {
  for (const [delivery, host, resume] of [["steer", "steer", true], ["queue", "queue", true], ["fyi", "steer", false]] as const) {
    const wire = encodeSynthetic({ ...peer, delivery });
    assert.equal(wire.delivery, host);
    assert.equal(wire.resume, resume);
  }
});
test("UTF-8 body and framing budgets reject, never truncate or split", () => {
  assert.ok(encodeSynthetic({ ...peer, body: "a".repeat(MAX_BODY_BYTES) }));
  assert.throws(() => encodeSynthetic({ ...peer, body: "a".repeat(MAX_BODY_BYTES + 1) }), /not sent/);
  assert.throws(() => encodeSynthetic({ ...peer, body: "😀".repeat(MAX_BODY_BYTES / 4 + 1) }), /not sent/);
  assert.throws(() => encodeSynthetic({ ...peer, body: "a".repeat(MAX_BODY_BYTES), sender: { ...peer.sender, sessionID: "x".repeat(5000) } }), /sender information.*limit/);
});
test("message rejection and uncertainty explain what happened and what to do next", async () => {
  for (const [tag, remedy] of [
    ["SessionNotFoundError", /Check the session ID/], ["InvalidRequestError", /Check its fields/],
    ["UnauthorizedError", /Check the server connection settings/], ["ForbiddenError", /Check the applicable permissions/],
  ] as const) {
    const result = await syntheticTransport(async () => { throw { _tag: tag }; }).admit(peer);
    assert.equal(result.status, "failed");
    assert.match(result.detail!, /message was not accepted/);
    assert.match(result.detail!, remedy);
    assert.doesNotMatch(result.detail!, /admission|wire limit/);
  }
  const result = await syntheticTransport(async () => { throw new Error("timeout"); }).admit(peer);
  assert.equal(result.status, "uncertain");
  assert.match(result.detail!, /Do not resend.*may already have been accepted/);
});
test("transport uncertainty never retries or claims definite failure", async () => {
  let calls = 0;
  const transport = syntheticTransport(async () => { calls++; throw new Error("timeout after host admission"); });
  assert.equal((await transport.admit(peer)).status, "uncertain");
  assert.equal(calls, 1);
  const rejected = syntheticTransport(async () => { throw { _tag: "SessionNotFoundError" }; });
  assert.equal((await rejected.admit(peer)).status, "failed");
});
test("replaceable adapter contract: same body, sender, recipient, intent and policy; no duplicated attribution", async () => {
  const recorded: PeerInput[] = [];
  // Test double for future native provenance, not a fabricated production API.
  const native: Transport = { guidance: "", admit: async input => {
    recorded.push(structuredClone(input));
    return { status: "admitted", inboxID: "future" };
  } };
  const f = fixture();
  f.sessions.get(call.sessionID)!.title = "Coordinator";
  const { Linklet } = await import("../src/linklet.js");
  const linklet = new Linklet(f.ctx, f.client, native);
  const body = " \nLinklet peer note — arbitrary body must remain unchanged\n ";
  await linklet.send({ sessionID: "ses_peer", text: body, delivery: "fyi" }, call);
  assert.equal(recorded[0].body, body);
  assert.deepEqual(recorded[0].sender, { sessionID: call.sessionID, agentID: call.agent });
  assert.equal(recorded[0].senderTitle, "Coordinator", "The logical adapter boundary includes the resolved display title");
  assert.equal(recorded[0].recipient.sessionID, "ses_peer");
  assert.equal(recorded[0].delivery, "fyi");
  assert.ok(await linklet.channels.has(recorded[0].sender, recorded[0].recipient));
  assert.equal(f.checks.length, 2);
  assert.equal(f.admissions.length, 0);
});
