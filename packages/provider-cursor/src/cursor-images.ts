/**
 * OpenAI image_url → Cursor SelectedImage parsing.
 *
 * Skeleton: the Cursor UserMessage SelectedImage proto field number and the
 * remote-image SSRF policy are pending a real capture (plan risk #2). The
 * data-URL path is implemented; remote URLs are deferred. fetch.ts does not
 * yet inject images into the AgentRunRequest — this module is a placeholder
 * for when the field layout is confirmed.
 */

import type { ChatCompletionsMessage } from '@floway-dev/protocols/chat-completions';

export interface CursorImageInput {
  // Raw image bytes (decoded from a data: URL).
  data: Uint8Array;
  // A hint dimension if the source carried one.
  detail?: 'low' | 'high' | 'auto';
}

const DATA_URL_RE = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s;

/**
 * Extract data-URL images from a message's content parts. Remote image_url
 * entries are skipped (TODO: fetch + SSRF guard once SelectedImage field
 * layout is confirmed).
 */
export const parseCursorImages = (message: ChatCompletionsMessage): CursorImageInput[] => {
  const content = message.content;
  if (!Array.isArray(content)) return [];

  const out: CursorImageInput[] = [];
  for (const part of content) {
    if (part.type !== 'image_url') continue;
    const url = part.image_url.url;
    const match = DATA_URL_RE.exec(url);
    if (!match) continue; // remote URL — deferred
    const base64 = match[2]!;
    try {
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      out.push({ data: bytes, detail: part.image_url.detail });
    } catch {
      // malformed base64 — skip
    }
  }
  return out;
};
