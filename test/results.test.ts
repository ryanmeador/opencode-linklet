import { test } from "node:test";
import assert from "node:assert/strict";
import { toolResult, projectText, sessionText, createText, sendText } from "../src/results.js";

test("project/session summaries keep useful IDs and paths without raw JSON", () => {
  const project = toolResult({ projects: [{ id: "project-id", name: "Named", canonical: "/canonical", checkouts: [] }], nextOffset: null }, projectText);
  assert.match(project.content, /Found 1 project/);
  assert.match(project.content, /Named — \/canonical/);
  assert.match(project.content, /project-id/);
  assert.match(project.content, /none recorded/);
  const page = toolResult({ sessions: [{ sessionID: "ses_test", directory: "/test", activity: "unknown", commitSHA: "a".repeat(40) }], nextCursor: "short-token", scanLimitReached: true }, sessionText);
  assert.match(page.content, /Found 1 session/);
  assert.match(page.content, /Last execution: not reported/);
  assert.match(page.content, /Scan limit reached/);
  assert.ok(page.content.includes(`HEAD: ${"a".repeat(40)}`));
});

test("creation and sending text keep uncertainty and acceptance distinct from completion", () => {
  const uncertain = createText({ status: "uncertain", directory: "/retained", worktree: "/retained-tree" });
  assert.match(uncertain, /Do not retry automatically/);
  assert.match(uncertain, /Worktree kept: \/retained-tree/);
  const created = createText({ status: "created", sessionID: "ses_test", directory: "/test", assignment: { status: "admitted" } });
  assert.match(created, /accepted; completion unconfirmed/);
  assert.equal(sendText({ status: "admitted", sessionID: "ses_test" }), "Message accepted; completion unconfirmed.");
  assert.equal(sendText({ status: "uncertain", sessionID: "ses_test" }), "Acceptance unconfirmed. Do not retry automatically.");
});
test("send receipts show actionable details without repeating a generic status", () => {
  const detail = "Acceptance unconfirmed. Do not resend automatically; it may already have been accepted.";
  assert.equal(sendText({ status: "uncertain", sessionID: "ses_test", detail }), detail);
  assert.equal(sendText({ status: "admitted", sessionID: "ses_test", warning: "Replies may need approval." }),
    "Message accepted; completion unconfirmed.\nReplies may need approval.");
});
test("routine message receipts do not expose session IDs in human-facing text", () => {
  for (const status of ["admitted", "uncertain", "failed"])
    assert.equal(sendText({ status, sessionID: "ses_internal" }).includes("ses_internal"), false);
});
