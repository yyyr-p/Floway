// The Claude Code model picker (enabled by the
// `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` env var) applies two
// filters to the `/v1/models` payload before populating its `/model`
// menu. Anthropic documents both filters at
// https://code.claude.com/docs/en/llm-gateway-protocol#model-discovery:
//
//   > Claude Code reads `id` and the optional `display_name` from each
//   > entry in the response's `data` array. It keeps an entry when its
//   > `id` contains `claude` or `anthropic` anywhere in the string,
//   > matched case-insensitively, and ignores the rest.
//
//   > A discovered ID is skipped when it exactly matches a row already
//   > in the picker, or when both the discovered and existing IDs
//   > resolve to Fable.
//
// The id filter was loosened in Claude Code v2.1.223: before that release
// the picker only kept ids that *began* with `claude` or `anthropic`
// (`/^(claude|anthropic)/i`), which hid provider-prefixed ids such as
// `vertex_ai/claude-sonnet-4-6`. The encoder here keeps the stricter
// begins-with predicate so a single encoding survives both picker
// generations — an id the new picker admits only by the contains-anywhere
// rule still gets the prefix, and `claude-code!` begins with `claude`, so
// the prefixed form also passes the old begins-with filter. Extracted
// from the compiled `Bootstrap Gateway /v1/models` handler in
// `@anthropic-ai/claude-code@2.1.211` (captured 2026-07-16 by grepping
// the Bun-compiled darwin-arm64 binary around the `[Bootstrap] Gateway
// /v1/models` telemetry strings); the docs are the primary
// source-of-truth and pin the `fable5` carve-out and evaluation order the
// prose leaves implicit.
//
// Newer Claude Code releases add a second, deny-side filter: a hardcoded
// list of rival-vendor model-name substrings (`deepseek`, `glm`, …) that
// the picker drops when an id *contains* any of them, case-insensitively.
// A plain `claude-code!<rawId>` prefix passes the allow filter but the
// raw id still carries the vendor name in the clear, so the deny filter
// silences exactly the non-Anthropic models the prefix exists to surface.
// Encoding the raw id as hex after the prefix closes that gap: hex's
// `[0-9a-f]` alphabet cannot spell any of the deny-listed vendor names
// (each contains at least one letter outside a–f), so the deny filter's
// `contains` check falls through while `claude-code!` still satisfies the
// allow filter. `display_name` is not subject to the deny filter, so the
// operator-configured label still reaches the user unchanged.
//
// Consequences for gateway callers:
//
//  - `label: display_name ?? id` — the picker renders `display_name` to
//    the user; the id itself is only shown on the wire. Rewriting the
//    id is invisible in the UI.
//  - `claude-code!` passes the id filter and never exact-matches a
//    built-in family string, so prefixed non-Anthropic ids survive both
//    filters without masquerading as an upstream-native Claude family.
//  - The prefix is an encoding marker, not a reserved model-id namespace.
//    Floway model ids are opaque, so discovery also encodes a raw id that
//    already begins with the marker. This prefix-doubling makes the mapping
//    injective: M, P+M, and P+P+M become P+hex(M), P+hex(P+M), and
//    P+hex(P+P+M) — the hex output never itself begins with `claude-code!`,
//    so the encoding never lands a second prefix adjacent to the first.
import { encodeHex, decodeHex } from '@floway-dev/protocols/common';

export const CLAUDE_CODE_SYNTHETIC_PREFIX = 'claude-code!';

// Ids the picker admits without a prefix. Uses the stricter begins-with
// form (the pre-v2.1.223 filter) rather than the current contains-anywhere
// rule so one encoding survives both picker generations — see the header
// comment. Kept next to the encoder so the accept and escape decisions
// cannot drift apart.
export const CLAUDE_CODE_PICKER_ID_ACCEPT = /^(claude|anthropic)/i;

// Stateless UTF-8 codec. `fatal: true` makes the decoder throw on invalid
// byte sequences so the decode path can distinguish a genuine hex-encoded
// id from a literal `claude-code!…` id whose suffix happens to parse as
// hex but decodes to non-UTF-8 garbage — the latter must pass through
// untouched.
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

export const encodeClaudeCodeModelId = (modelId: string): string =>
  CLAUDE_CODE_PICKER_ID_ACCEPT.test(modelId)
  && !modelId.startsWith(CLAUDE_CODE_SYNTHETIC_PREFIX)
    ? modelId
    : `${CLAUDE_CODE_SYNTHETIC_PREFIX}${encodeHex(utf8Encoder.encode(modelId))}`;

// The Claude Desktop app embeds the same Claude Code picker the standalone
// CLI serves, but its HTTP layer is an Electron browser fetch. Both its
// `/v1/models` discovery and its `/v1/messages` inference therefore carry
// the desktop app's `Mozilla/5.0 … Claude/<version> … Electron/…`
// User-Agent instead of the CLI's `claude-code/<version>` (discovery) or
// `claude-cli/<version>` (inference) tokens. The `Claude/<version>`
// product token (capital C, no hyphen) is the stable desktop-app signal;
// neither CLI token contains it, and no Anthropic SDK does either. The
// shared `.*\bClaude\/\d` alternative below admits that desktop UA on
// both the discovery and inference paths.
const CLAUDE_CODE_DISCOVERY_USER_AGENT = /^(?:claude-code\/|.*\bClaude\/\d)/;

export const isClaudeCodeDiscoveryUserAgent = (userAgent: string | undefined): boolean =>
  userAgent !== undefined && CLAUDE_CODE_DISCOVERY_USER_AGENT.test(userAgent);

// Claude Code inference requests use the Anthropic SDK's `claude-cli/*`
// User-Agent rather than the `claude-code/*` discovery identity; the
// Claude Desktop app reuses the picker but sends the Electron UA above.
// All three carry the same prefixed discovery ids back on the wire, so
// all three need the prefix stripped before Messages model resolution;
// other clients' opaque ids pass through untouched. The `claude-cli/`
// leading product token is part of the real-client detector documented at
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/claude_code_validator.go
const CLAUDE_CODE_INFERENCE_USER_AGENT = /^(?:claude-cli\/|.*\bClaude\/\d)/;

export const decodeClaudeCodeModelId = (
  modelId: string,
  userAgent: string | undefined,
): string => {
  if (!CLAUDE_CODE_INFERENCE_USER_AGENT.test(userAgent ?? '')) return modelId;
  if (!modelId.startsWith(CLAUDE_CODE_SYNTHETIC_PREFIX)) return modelId;
  const suffix = modelId.slice(CLAUDE_CODE_SYNTHETIC_PREFIX.length);
  // `decodeHex` throws on non-hex characters or odd length; the fatal UTF-8
  // decoder throws on bytes that are not a valid UTF-8 sequence. A literal
  // `claude-code!…` id whose suffix is not hex, or decodes to non-UTF-8,
  // is not one of our encoded ids — pass it through untouched rather than
  // corrupting it. This is deliberately stricter than the old "always
  // strip one prefix layer": the old form never had a byte-valid suffix
  // to misparse, but the hex suffix can coincidentally parse from a
  // literal id, so the round-trip must be verified end to end.
  try {
    return utf8Decoder.decode(decodeHex(suffix));
  } catch {
    return modelId;
  }
};
