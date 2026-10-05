import { AffinityRequestContext } from './affinity/index.ts';
import { apiKeyFromContext, type AuthedContext } from '../../../middleware/auth.ts';
import type { ApiKey } from '../../../repo/types.ts';
import { createGatewayCtxFromHono, type CreateGatewayCtxOptions, type GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { OpenAIResponsesStatefulStore } from '../openai-responses/items/store.ts';

// Chat-protocol ctx adds the affinity membrane and the OpenAI Responses item store.
// The store is present on every chat ctx: native OpenAI Responses entries supply a
// persisting factory, non-OpenAI-Responses sources a no-backing scratchpad store, so
// the server-tool shim's request-private state always has a home. Every chat
// HTTP/WS entry constructs this via `createChatGatewayCtxFromHono` and threads
// it through serve → narrow → attempt. Passthrough endpoints (OpenAI
// Embeddings / OpenAI Images / OpenAI Audio Transcriptions / OpenAI
// Completions) have no stored-items concept and stay on plain `GatewayCtx`.
export interface ChatGatewayCtx extends GatewayCtx {
  readonly affinity: AffinityRequestContext;
  readonly store: OpenAIResponsesStatefulStore;
}

// Chat-protocol counterpart of `createGatewayCtxFromHono`. The factory receives
// the authoritative API key. Native OpenAI Responses HTTP and WebSocket entries
// supply a persisting store factory; non-OpenAI-Responses sources supply
// `createNonOpenAIResponsesSourceStore`, so every chat ctx carries a store.
export const createChatGatewayCtxFromHono = (
  c: AuthedContext,
  opts: CreateGatewayCtxOptions,
  storeFactory: (apiKey: ApiKey, requestStartedAt: number) => OpenAIResponsesStatefulStore,
): ChatGatewayCtx => {
  const base = createGatewayCtxFromHono(c, opts);
  const apiKey = apiKeyFromContext(c);
  // Read identity before provider allowlists filter headers.
  // https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/gateway_service.go#L421-L444
  // https://github.com/openai/codex/blob/a16863f8704831d13e041ed7dba2c4a57a2a940b/codex-rs/core/src/responses_metadata.rs#L184-L189
  const sessionId = ['x-claude-code-session-id', 'session-id', 'session_id']
    .map(name => c.req.header(name)?.trim()).find(value => value !== undefined && value.length > 0);
  return {
    ...base,
    affinity: new AffinityRequestContext(apiKey.serverSecret, { apiKeyId: apiKey.id, id: sessionId }),
    store: storeFactory(apiKeyFromContext(c), base.requestStartedAt),
  };
};
