import type { FlagDefaults } from '@floway-dev/provider';

// Exhaustive flag defaults for Antigravity (Google Cloud Code subscription)
// upstreams. The wire only speaks native Gemini generateContent, so the
// surface is narrow:
//
// * Hosted-tool shims stay off — the Antigravity wire has no web-search /
//   image-generation / compact surface of its own, and a gateway-side shim
//   would pretend to a capability the upstream denies.
// * `strip-billing-attribution` defaults on: the subscription is billed
//   against the OAuth account, and inbound clients have no billing
//   attribution this wire could honor.
export const ANTIGRAVITY_DEFAULT_FLAGS: FlagDefaults = {
  'vendor-deepseek': false,
  'vendor-qwen': false,
  'vendor-kimi': false,
  'anthropic-messages-web-search-shim': false,
  'openai-responses-web-search-shim': false,
  'openai-responses-image-generation-shim': false,
  'openai-responses-compact-shim': false,
  'openai-responses-compact-decrypt': false,
  'openai-responses-collaboration-shim': false,
  'openai-responses-agent-message-shim': false,
  'disable-reasoning-on-forced-tool-choice': false,
  'empty-tools-tool-choice-none': false,
  'rewrite-mid-conv-system-to-user': false,
  'rewrite-developer-to-system': false,
  'rewrite-system-to-developer': false,
  'strip-billing-attribution': true,
  'strip-prompt-cache-key': false,
  'usage-exclusive-cached-tokens': false,
};
