// Antigravity envelope: wraps the standard Gemini generateContent payload in
// the Cloud Code `{project, model, userAgent, requestType, requestId,
// request}` envelope, and unwraps the response the same way — every SSE
// chunk arrives as `{"response": <gemini chunk>}` and a turn the upstream
// never terminated gets a synthetic STOP chunk at the close.
//
// Wire reference — CLIProxyAPI's request/response translators:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/translator/antigravity/gemini/antigravity_gemini_request.go
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/translator/antigravity/gemini/antigravity_gemini_response.go
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/executor/antigravity_executor_request.go

import type {
  GeminiGenerateContentPayload,
  GeminiGenerateContentResult,
  GeminiGenerateContentStreamEvent,
  GeminiGenerateContentUsageMetadata,
} from '@floway-dev/protocols/gemini-generate-content';

export interface AntigravityEnvelopeArgs {
  projectId: string;
  // The upstream model id riding both the URL and the envelope's `model`
  // field. Antigravity addresses requests by id in BOTH places — the
  // generateContent payload's model field is deleted by the translator
  // before wrapping.
  model: string;
  payload: GeminiGenerateContentPayload;
}

// Stable session id for a request: Antigravity correlates turns through
// `request.sessionId`. The gateway derives it from the first user-turn text
// hash so a re-tried conversation re-uses the same session slot, matching
// CLIProxyAPI's derivation, with a random fallback for payloads without a
// usable first text.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/translator/antigravity/gemini/antigravity_gemini_request.go
const deriveSessionId = async (payload: GeminiGenerateContentPayload): Promise<string> => {
  let candidate: string | null = null;
  for (const content of payload.contents ?? []) {
    if (content.role !== 'user') continue;
    const text = content.parts.find(part => typeof part.text === 'string' && part.text !== '')?.text;
    if (text !== undefined) { candidate = text; break; }
  }
  if (candidate !== null) {
    // First 8 bytes of the SHA-256 digest as a big-endian integer, rendered
    // `-<n>`.
    const digest = await digestBytes(candidate);
    let value = 0n;
    for (let i = 0; i < 8; i++) value = (value << 8n) | BigInt(digest[i]!);
    return `-${value}`;
  }
  return `-${crypto.randomUUID()}`;
};

const digestBytes = (text: string): Promise<Uint8Array> =>
  crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(buffer => new Uint8Array(buffer));

export const buildAntigravityEnvelope = (args: AntigravityEnvelopeArgs): Promise<Record<string, unknown>> => {
  const { request } = strippedGeminiRequest(args.payload);
  return deriveSessionId(args.payload).then(sessionId => ({
    project: args.projectId,
    model: args.model,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${crypto.randomUUID()}`,
    request: { ...request, sessionId },
  }));
};

// Per the CLIProxyAPI translator: the top-level payload drops `model` (the
// envelope carries it), drops `safetySettings`, and keeps
// `toolConfig`/`generationConfig` inside the inner request — while the inner
// request itself drops its own `safetySettings` (the gateway payload has a
// single flat shape, so both deletions collapse into one here).
const strippedGeminiRequest = (payload: GeminiGenerateContentPayload): { request: Record<string, unknown> } => {
  const { model: _model, safetySettings: _safety, ...rest } = payload as GeminiGenerateContentPayload & { model?: unknown };
  return { request: rest };
};

// Response unwrapping. The streaming wire is `data: {"response": <chunk>}`;
// a non-terminal chunk's `usageMetadata` is dropped (CLIProxyAPI renames it
// to `cpaUsageMetadata` for client compatibility — dropping achieves the
// same client-visible shape with less state), and a stream that never
// delivers a finishReason gets a synthetic STOP chunk synthesized at
// [DONE] so the reassembler and the usage reader see a terminal.
const stripEnvelope = (event: Record<string, unknown>): GeminiGenerateContentStreamEvent | null =>
  ('response' in event && typeof event.response === 'object' && event.response !== null
    ? event.response as GeminiGenerateContentStreamEvent
    : null);

// Usage figures staged on pre-terminal chunks are retained in state so the
// synthetic terminal (and the billable reader's last-wins read) still sees
// them — Antigravity commonly streams usage counts before the finishReason
// lands.
export interface AntigravityUnwrapState {
  sawTerminal: boolean;
  lastUsageMetadata: GeminiGenerateContentUsageMetadata | null;
}

export const createAntigravityUnwrapState = (): AntigravityUnwrapState => ({ sawTerminal: false, lastUsageMetadata: null });

const syntheticStopChunk = (usage: GeminiGenerateContentUsageMetadata | null, model: string): GeminiGenerateContentResult => ({
  candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, finishReason: 'STOP', index: 0 }],
  ...(usage !== null ? { usageMetadata: usage } : {}),
  modelVersion: model,
});

// Wraps the protocol parser's per-event callback: unwrap the envelope,
// remember the last-seen usage (any chunk may carry figures), drop
// usageMetadata from non-terminal chunks, and — on upstream close without a
// terminal — yield a synthesized STOP chunk carrying that usage.
export const unwrapAntigravitySseChunk = (
  raw: Record<string, unknown>,
  state: AntigravityUnwrapState,
): GeminiGenerateContentStreamEvent[] => {
  const inner = stripEnvelope(raw);
  if (inner === null) return [];
  if ('error' in inner) return [inner];
  const result = inner as GeminiGenerateContentResult;
  if (result.candidates?.some(candidate => candidate.finishReason !== undefined) === true) {
    state.sawTerminal = true;
    return [result];
  }
  if (result.usageMetadata !== undefined) state.lastUsageMetadata = result.usageMetadata;
  const { usageMetadata: _usage, ...rest } = result;
  return [rest];
};

// Terminal synthesis at [DONE]: carries the last-observed usage so the
// billable-usage read doesn't lose counts the upstream only staged on
// pre-terminal chunks.
export const syntheticTerminalIfMissing = (
  state: AntigravityUnwrapState,
  model: string,
): GeminiGenerateContentStreamEvent[] => {
  if (state.sawTerminal) return [];
  state.sawTerminal = true;
  return [syntheticStopChunk(state.lastUsageMetadata, model)];
};
