/**
 * Cursor rate-limit / quota parsing.
 *
 * Cursor's rate-limit signal is not yet capture-confirmed (the agent endpoints
 * return 429 with TBD headers). This module owns the snapshot shape and the
 * 429 detection used by fetch.ts; header parsing is a placeholder to be filled
 * from a real capture (see plan risk #4).
 */

export interface CursorQuotaSnapshot {
  // Placeholder fields — populate from real 429/Retry-After capture.
  remaining?: number;
  limit?: number;
  resetAt?: number;
}

// CursorQuotaSnapshotEntry (the fetchedAt + data wrapper) lives in state.ts,
// alongside the credential that carries it — not here.

/** True when the upstream response signals rate-limiting (HTTP 429). */
export const isCursorRateLimited = (status: number): boolean => status === 429;

/**
 * Parse quota hints from upstream response headers. Returns null until real
 * header fields are captured; callers treat null as "no quota observation".
 */
export const parseCursorQuotaHeaders = (_headers: Headers): CursorQuotaSnapshot | null => {
  // TODO(cursor): populate from real Retry-After / x-cursor-ratelimit-* capture.
  return null;
};
