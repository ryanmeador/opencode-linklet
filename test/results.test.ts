import { test } from "node:test";
import assert from "node:assert/strict";
import { toolResult, projectText, sessionText, createText, sendText } from "../src/results.js";

test("project/session summaries keep useful IDs and paths without raw JSON", () => {
  const project = toolResult({ projects: [{ id: "project-id", name: "Named", canonical: "/canonical", checkouts: [] }], nextOffset: null }, projectText);
  assert.match(project.content, /Found 1 project/);
  assert.match(project.content, /Named — \/canonical/);
  assert.match(project.content, /project-id/);
  assert.match(project.content, /none recorded/);
  const page = toolResult({ sessions: [{ sessionID: "ses_test", directory: "/test", activity: "unknown" }], nextCursor: "short-token", scanLimitReached: true }, sessionText);
  assert.match(page.content, /Found 1 session/);
  assert.match(page.content, /Last execution: not reported/);
  assert.match(page.content, /Scan limit reached/);
});

test("creation and sending text keep uncertainty and acceptance distinct from completion", () => {
  const uncertain = createText({ status: "uncertain", directory: "/retained", worktree: "/retained-tree" });
  assert.match(uncertain, /Do not repeat the request automatically/);
  assert.match(uncertain, /Worktree kept: \/retained-tree/);
  const created = createText({ status: "created", sessionID: "ses_test", directory: "/test", assignment: { status: "admitted" } });
  assert.match(created, /not confirmed started or completed/);
  assert.match(sendText({ status: "admitted", sessionID: "ses_test" }), /does not confirm it was read or completed/);
  assert.match(sendText({ status: "uncertain", sessionID: "ses_test" }), /Do not resend it automatically/);
});
