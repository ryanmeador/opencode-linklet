// Explicit schemas make Code Mode return typed objects instead of JSON strings.
const text = { type: "string" } as const;
const object = (properties: Record<string, unknown>, required: string[]) =>
  ({ type: "object" as const, properties, required, additionalProperties: false });
const list = (items: unknown) => ({ type: "array" as const, items });
const activity = { type: "string", enum: ["running", "blocked", "idle", "unknown"] };
const receiptProperties = {
  status: { type: "string", enum: ["admitted", "uncertain", "failed"],
    description: "admitted means OpenCode accepted the message, not that it was read or completed. Never automatically retry uncertain delivery." },
  inboxID: text, detail: text,
};
export const projectOutput = object({
  projects: list(object({ id: text, name: text, canonical: text,
    checkouts: list(object({ directory: text, strategy: text }, ["directory"])) }, ["id", "canonical", "checkouts"])),
  nextOffset: { type: ["integer", "null"] },
}, ["projects", "nextOffset"]);

export const sessionOutput = object({
  sessions: list(object({ sessionID: text, title: text, projectID: text, directory: text,
    parentID: text, creatorID: text, activity, reason: text,
    lastExecutionAt: { type: "string", format: "date-time",
      description: "Latest known execution start or end, in UTC. Omitted when unknown; viewing, creation, and generic updates are not counted." },
  }, ["sessionID", "projectID", "directory", "activity"])),
  nextCursor: { type: ["string", "null"], description: "Copy this short page token into cursor, keeping all filters unchanged. Null means the search is complete." },
  scanLimitReached: { type: "boolean", description: "If true, this call reached its scan bound. Continue with nextCursor to examine more candidates; another matching result is not guaranteed." },
}, ["sessions", "nextCursor"]);

export const createOutput = object({
  status: { type: "string", enum: ["created", "failed", "uncertain"] },
  sessionID: text, directory: text, worktree: text, independent: { type: "boolean" },
  activity, assignment: object(receiptProperties, ["status"]), stage: text, detail: text, retained: text,
}, ["status", "directory"]);

export const sendOutput = object({ ...receiptProperties, sessionID: text,
  delivery: { type: "string", enum: ["steer", "queue", "fyi"] }, warning: text,
}, ["status", "sessionID"]);

export function toolResult<T>(value: T, readable: (output: T) => string): { output: T; content: string } {
  // Optional properties must be absent, not explicit undefined, at the host's
  // schema boundary. Keep text and structured results consistent.
  const output = JSON.parse(JSON.stringify(value)) as T;
  return { output, content: readable(output) };
}

export function projectText(result: { projects: { id: string; name?: string; canonical: string; checkouts: { directory: string }[] }[]; nextOffset: number | null }) {
  return [`Found ${result.projects.length} ${result.projects.length === 1 ? "project" : "projects"}.`, ...result.projects.map(project =>
    `- ${project.name ? `${project.name} — ${project.canonical}` : project.canonical}\n  ID: ${project.id}\n  Checkouts: ${project.checkouts.map(checkout => checkout.directory).join(", ") || "none recorded"}`),
  result.nextOffset !== null ? `Next page: offset ${result.nextOffset}.` : ""].filter(Boolean).join("\n");
}
export function sessionText(result: { sessions: { sessionID: string; title?: string; directory: string; activity: string; lastExecutionAt?: string; reason?: string; parentID?: string; creatorID?: string }[]; nextCursor: string | null; scanLimitReached?: boolean }) {
  return [`Found ${result.sessions.length} ${result.sessions.length === 1 ? "session" : "sessions"}.`, ...result.sessions.map(session => [
    `- ${session.title || "(untitled)"} — ${session.activity}${session.reason ? ` (${session.reason})` : ""}`,
    `  ID: ${session.sessionID}`, `  Directory: ${session.directory}`,
    `  Last execution: ${session.lastExecutionAt ?? "not reported"}`,
    session.parentID ? `  Parent: ${session.parentID}` : "", session.creatorID ? `  Creator: ${session.creatorID}` : "",
  ].filter(Boolean).join("\n")), result.nextCursor ? `Next page: ${result.nextCursor}.` : "",
  result.scanLimitReached ? "Scan limit reached. Continue with nextCursor to check more candidates; there may be no more matches." : ""].filter(Boolean).join("\n");
}
export function createText(result: { status: string; sessionID?: string; directory: string; worktree?: string; assignment?: { status: string; detail?: string }; detail?: string; retained?: string }) {
  return [result.status === "created" ? `Created session ${result.sessionID}.` :
    result.status === "uncertain" ? "Could not confirm whether session creation completed. Do not repeat the request automatically." : "Session setup could not be completed.",
    result.status !== "created" && result.sessionID ? `Known session: ${result.sessionID}.` : "",
    `Directory: ${result.directory}`, result.worktree ? `Worktree kept: ${result.worktree}` : "",
    result.assignment ? `Initial task: ${result.assignment.status === "admitted" ? "accepted by OpenCode; not confirmed started or completed" : result.assignment.status}.` : "",
    result.assignment?.detail, result.detail, result.retained].filter(Boolean).join("\n");
}
export function sendText(result: { status: string; sessionID: string; detail?: string; warning?: string }) {
  return [result.status === "admitted" ? "OpenCode accepted the message. This does not confirm it was read or completed." :
    result.status === "uncertain" ? "Could not confirm whether OpenCode accepted the message. Do not resend it automatically." :
      "OpenCode did not accept the message.", result.detail, result.warning].filter(Boolean).join("\n");
}
