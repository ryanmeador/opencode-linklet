import type { SessionInfo } from "@opencode/client";

export type Relationship = "all" | "roots" | "siblings";
export interface FindInput {
  project?: string; all?: boolean; search?: string; limit?: number; cursor?: string; sessionID?: string;
  relationship?: Relationship; activeSince?: string;
}

/** Execution boundaries only: updates, viewing, titles and creation are not work. */
export function lastExecutionTime(session: SessionInfo): number | undefined {
  const times = [session.time.busy, session.time.idle].filter((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime()));
  return times.length ? Math.max(...times) : undefined;
}

export function parseActiveSince(value?: string): number | undefined {
  if (value === undefined) return undefined;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const parsed = Date.parse(value);
  const date = parts ? new Date(`${parts[1]}T00:00:00Z`) : undefined;
  if (!parts || !Number.isFinite(parsed) || !date || Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== parts[1] || +parts[2] > 23 || +parts[3] > 59 || +parts[4] > 59)
    throw new Error("activeSince must be an ISO 8601 timestamp with a timezone, such as 2026-11-08T12:00:00Z. Calculate the desired cutoff, or omit activeSince to search without a time filter.");
  return parsed;
}

// Bounds work on large inventories without pretending a partial scan is complete.
export const MAX_SCANNED_SESSIONS = 1000;
