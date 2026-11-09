import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Read checkout HEAD only; never scan files, fetch, or modify the repository. */
export async function checkoutCommit(directory: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const env = { ...process.env };
    // The session's directory, not inherited Git overrides, selects the repo.
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"]) delete env[key];
    const { stdout } = await exec("git", ["--no-pager", "--no-optional-locks", "rev-parse", "--verify", "HEAD"],
      { cwd: directory, env, timeout: 2000, maxBuffer: 4096, signal });
    const sha = stdout.trim();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha) ? sha : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}
