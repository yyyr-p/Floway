// Serialize the caller's request payload for the judge request, with the
// deterministic ordering and head+tail truncation the gate depends on.
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { stableStringify } from './stable-stringify.ts';

// Fixed 8000-char reserve covering the prefix/suffix prompts, the judge
// output's reason line, and the token↔char estimation error. Absolute, not
// a percentage: a percentage of a 1M-token window dwarfs the prompts while
// one of an 8k window starves them.
export const PAYLOAD_CHAR_RESERVE = 8000;
export const CHARS_PER_TOKEN_ESTIMATE = 4;
// Fallback cap when the judge model declares no max context window; the
// dashboard tells the operator this fallback is in force.
export const FALLBACK_MAX_PAYLOAD_CHARS = 32000;

export const estimateMaxPayloadChars = (maxContextWindowTokens: number | null | undefined): number => {
  if (typeof maxContextWindowTokens !== 'number' || maxContextWindowTokens <= 0) return FALLBACK_MAX_PAYLOAD_CHARS;
  return Math.max(FALLBACK_MAX_PAYLOAD_CHARS, maxContextWindowTokens * CHARS_PER_TOKEN_ESTIMATE - PAYLOAD_CHAR_RESERVE);
};

const TRUNCATION_MARKER = (omitted: number) => `[...truncated ${omitted} chars...]`;

// Keep the head and the tail of an over-limit string and replace the middle
// with a marker. Deterministic for a given input and cap: the split points
// depend only on length, so the same payload always truncates identically.
export const truncateMiddle = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;
  const marker = TRUNCATION_MARKER(text.length - maxChars);
  const budget = Math.max(0, maxChars - marker.length);
  const half = Math.floor(budget / 2);
  return `${text.slice(0, half)}${marker}${text.slice(text.length - half)}`;
};

export interface SerializedPayload {
  readonly text: string;
  readonly truncated: boolean;
  readonly sha256: string;
}

// Deterministic serialized form of the caller's request payload. The digest
// is taken over the pre-truncation text so audit rows for the same payload
// match regardless of the cap in force when each was judged.
export const serializePayload = (
  payload: unknown,
  maxPayloadChars: number,
): SerializedPayload => {
  const text = stableStringify(payload);
  const payloadSha256 = bytesToHex(sha256(utf8ToBytes(text)));
  return { text: truncateMiddle(text, maxPayloadChars), truncated: text.length > maxPayloadChars, sha256: payloadSha256 };
};

const utf8ToBytes = (text: string): Uint8Array => new TextEncoder().encode(text);
