/** A display label only; names never determine identity or authorization. */
export function sessionLabel(sessionID: string, title?: string): string {
  return title?.replace(/\s+/g, " ").trim() || sessionID;
}
