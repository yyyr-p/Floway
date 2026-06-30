/**
 * Cursor session protocol state — per-session generator + transport + seqno.
 *
 * Separate from DurableHttpSession because what we actually persist is the
 * **live async generator** (the transport's openChatStream iterator) — not
 * raw HTTP bytes. On Node this is a plain Map; on CF (future) the session
 * will be reconstructed from the DurableHttpSession body bytes.
 *
 * Follows the same "in-process Map" pattern as provider-copilot/src/auth.ts:42
 * (inProcessTokenCache) and opencode-cursor-proxy/src/lib/session-reuse.ts
 * (sessionMap holding session.iterator).
 */

import type { AgentStreamChunk } from './proto/index.ts';

export interface CursorSessionEntry {
  /** The live transport generator — continue pulling for follow-up chunks. */
  gen: AsyncGenerator<AgentStreamChunk>;
  /** Send tool result via BidiAppend on the same session. */
  sendMcpResult: (execId: number, mcpExecId: string | undefined, result: { success?: { content: string; isError?: boolean }; error?: string }) => Promise<void>;
  /** Tell cursor to resume streaming after tool results. */
  sendResumeAction: () => Promise<void>;
  /** Pending exec requests (tool_call_id → exec info) for matching results. */
  pendingExecs: Map<string, { id: number; execId: string | undefined }>;
  /** session key for back-reference. */
  sessionKey: string;
  /** Timestamp of last activity for idle eviction. */
  lastActivityAt: number;
}

const sessions = new Map<string, CursorSessionEntry>();

const IDLE_TTL_MS = 5 * 60 * 1000;

export function getCursorSession(sessionKey: string): CursorSessionEntry | null {
  const entry = sessions.get(sessionKey);
  if (!entry) return null;
  entry.lastActivityAt = Date.now();
  return entry;
}

export function putCursorSession(entry: CursorSessionEntry): void {
  entry.lastActivityAt = Date.now();
  sessions.set(entry.sessionKey, entry);
}

export function deleteCursorSession(sessionKey: string): void {
  const entry = sessions.get(sessionKey);
  if (entry) {
    // Close the generator to release the transport's RunSSE read.
    void entry.gen.return(undefined);
    sessions.delete(sessionKey);
  }
}

// Lazy idle sweep — runs on every get/put; evicts stale entries.
function sweepIdle(): void {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (now - entry.lastActivityAt > IDLE_TTL_MS) {
      void entry.gen.return(undefined);
      sessions.delete(key);
    }
  }
}

// Run sweep periodically (piggyback on get/put).
let lastSweep = 0;
function maybeSweep(): void {
  const now = Date.now();
  if (now - lastSweep > 30_000) {
    lastSweep = now;
    sweepIdle();
  }
}

export { maybeSweep as _sweepHook };
