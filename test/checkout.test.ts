import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { checkoutCommit } from "../src/checkout.js";

const exec = promisify(execFile);
test("checkout HEAD supports subdirectories, detached HEAD and worktrees; missing commits are omitted", async t => {
  const root = await mkdtemp("/tmp/opencode/linklet-head-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo"), worktree = join(root, "worktree");
  await mkdir(repo);
  const git = (...args: string[]) => exec("git", ["--no-pager", "-C", repo, ...args]);
  assert.equal(await checkoutCommit(root), undefined);
  assert.equal(await checkoutCommit(join(root, "missing")), undefined);
  await git("init");
  assert.equal(await checkoutCommit(repo), undefined, "Unborn HEAD is unavailable");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "First");
  const sha = (await git("rev-parse", "HEAD")).stdout.trim();
  await mkdir(join(repo, "nested"));
  assert.equal(await checkoutCommit(join(repo, "nested")), sha);
  await git("worktree", "add", "--detach", worktree, "HEAD");
  assert.equal(await checkoutCommit(worktree), sha);
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Second");
  assert.notEqual(await checkoutCommit(repo), sha, "Reads current HEAD rather than caching across calls");
  assert.equal(await checkoutCommit(worktree), sha, "Worktree uses its own HEAD");
});
test("cancelled checkout inspection propagates cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(checkoutCommit("/tmp/opencode", controller.signal), { name: "AbortError" });
});
