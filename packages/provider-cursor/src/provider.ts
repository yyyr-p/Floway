import { ensureCursorAccessToken, mintCursorAccessToken } from './access-token-cache.ts';
import { CursorSessionTerminatedError } from './auth/oauth.ts';
import { assertCursorUpstreamRecord, type CursorUpstreamConfig } from './config.ts';
import { callCursorChatCompletions, type CursorCallEffects } from './fetch.ts';
import { cursorChatCompletionsChain } from './interceptors/chat-completions/index.ts';
import type { ChatCompletionsBoundaryCtx } from './interceptors/chat-completions/types.ts';
import { cursorRawToUpstreamModel, fetchCursorCatalog } from './models.ts';
import { pricingForCursorModelKey } from './pricing.ts';
import { assertCursorUpstreamState, type CursorUpstreamState } from './state.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import {
  defaultsForProvider,
  getProviderRepo,
  resolveEffectiveFlags,
  type ModelProvider,
  type ModelProviderInstance,
  type ProviderCallResult,
  type ProviderCompactionResult,
  type ProviderStreamResult,
  type UpstreamCallOptions,
  type UpstreamRecord,
} from '@floway-dev/provider';

const gatewayTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

export const createCursorProvider = async (record: UpstreamRecord): Promise<ModelProviderInstance> => {
  assertCursorUpstreamRecord(record);
  assertCursorUpstreamState(record.state);
  const config: CursorUpstreamConfig = record.config;
  // Always operates on the first account in the pool. The schema carries an
  // array so a future fan-out can pick a different active account per call
  // without a wire migration.
  const accountIdentity = config.accounts[0];

  const enabledFlags = resolveEffectiveFlags(defaultsForProvider('cursor'), [record.flagOverrides]);

  // Re-read upstream state on every request rather than capturing the record's
  // state at construction. Refresh-token rotation, terminal-state transitions,
  // and operator re-imports must all be visible to the next in-flight call.
  const readActiveAccount = async () => {
    const fresh = await getProviderRepo().upstreams.getById(record.id);
    if (!fresh) throw new Error(`Cursor upstream ${record.id} disappeared mid-request`);
    assertCursorUpstreamState(fresh.state);
    const state = fresh.state;
    const account = state.accounts.find(a => a.userId === accountIdentity.userId);
    if (!account) {
      throw new Error(`Cursor upstream ${record.id} state has no credential for account ${accountIdentity.userId}`);
    }
    return { state, account };
  };

  const replaceActiveAccount = (
    state: CursorUpstreamState,
    next: CursorUpstreamState['accounts'][number],
  ): CursorUpstreamState => ({
    accounts: state.accounts.map(a => (a.userId === next.userId ? next : a)),
  });

  const persistRefreshTokenRotation = async (newRefreshToken: string): Promise<void> => {
    const { state, account } = await readActiveAccount();
    const next = replaceActiveAccount(state, {
      ...account,
      refresh_token: newRefreshToken,
      state_updated_at: new Date().toISOString(),
    });
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
  };

  const persistTerminalState = async (
    newState: 'session_terminated' | 'refresh_failed',
    message: string,
  ): Promise<void> => {
    const { state, account } = await readActiveAccount();
    const next = replaceActiveAccount(state, {
      ...account,
      state: newState,
      state_message: message,
      state_updated_at: new Date().toISOString(),
      accessToken: null,
    });
    await getProviderRepo().upstreams.saveState(record.id, next, { expectedState: state });
  };

  const effects: CursorCallEffects = { persistRefreshTokenRotation, persistTerminalState };

  const provider: ModelProvider = {
    getProvidedModels: async fetcher => {
      // A model-list refresh is the first thing a brand-new Cursor upstream
      // does, and it mints an access token. If the refresh_token has been
      // revoked, flip the row to refresh_failed and rethrow.
      let access;
      try {
        access = await ensureCursorAccessToken(record.id, accountIdentity.userId, refresh =>
          mintCursorAccessToken(refresh, fetcher, persistRefreshTokenRotation));
      } catch (err) {
        if (err instanceof CursorSessionTerminatedError) {
          await persistTerminalState('refresh_failed', err.upstreamMessage);
        }
        throw err;
      }
      const raw = await fetchCursorCatalog({ accessToken: access.token, timezone: gatewayTimezone(), fetcher, maxMode: config.maxMode });
      return raw.map(r => cursorRawToUpstreamModel(r, enabledFlags));
    },

    // Cursor bills as a flat-fee subscription; the dashboard reports notional
    // cost per request as if paying the underlying model's public API rates.
    getPricingForModelKey: pricingForCursorModelKey,

    callChatCompletions: async (model, body, signal, opts) => {
      const ctx: ChatCompletionsBoundaryCtx = {
        payload: { ...body, model: model.id },
        headers: new Headers(opts.headers),
        model,
      };
      return await runInterceptors<ChatCompletionsBoundaryCtx, object, ProviderStreamResult<ChatCompletionsStreamEvent>>(
        ctx,
        {},
        cursorChatCompletionsChain<ProviderStreamResult<ChatCompletionsStreamEvent>>(),
        async () => {
          const { account } = await readActiveAccount();
          const { model: _ignored, ...wireBody } = ctx.payload;
          return await callCursorChatCompletions({
            upstreamId: record.id,
            account,
            model,
            body: wireBody,
            headers: ctx.headers,
            signal,
            effects,
            call: opts,
            maxMode: config.maxMode ?? false,
          });
        },
      );
    },

    // Cursor upstream only exposes Chat Completions (RunSSE+BidiAppend);
    // getProvidedModels advertises that single endpoint. Every other surface
    // returns a 405 carrying a proper JSON error rather than a raw stack trace.
    // The synthetic response still flows through the per-call latency recorder
    // so the gateway's wrap-once contract holds.
    callMessages: (_m, _b, _s, opts) => unsupportedStreamResult(opts),
    callResponses: (_m, _b, _s, opts) => unsupportedStreamResult(opts),
    callMessagesCountTokens: (_m, _b, _s, opts) => unsupportedCallResult(opts),
    callCompletions: (_m, _b, _s, opts) => unsupportedCallResult(opts),
    callResponsesCompact: (_m, _b, _s, opts) => unsupportedCompactionResult(opts),
    callEmbeddings: (_m, _b, _s, opts) => unsupportedCallResult(opts),
    callImagesGenerations: (_m, _b, _s, opts) => unsupportedCallResult(opts),
    callImagesEdits: (_m, _b, _s, opts) => unsupportedCallResult(opts),
  };

  return {
    upstream: record.id,
    providerKind: 'cursor',
    name: record.name,
    disabledPublicModelIds: record.disabledPublicModelIds,
    modelPrefix: record.modelPrefix,
    provider,
    supportsResponsesItemReference: false,
  };
};

const synthetic405 = (): Response =>
  new Response(
    JSON.stringify({ error: { type: 'method_not_allowed', message: 'Endpoint not supported by cursor provider' } }),
    { status: 405, headers: { 'content-type': 'application/json' } },
  );

const unsupportedStreamResult = async <TEvent>(opts: UpstreamCallOptions): Promise<ProviderStreamResult<TEvent>> => ({
  ok: false,
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});

const unsupportedCallResult = async (opts: UpstreamCallOptions): Promise<ProviderCallResult> => ({
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});

const unsupportedCompactionResult = async (opts: UpstreamCallOptions): Promise<ProviderCompactionResult> => ({
  ok: false,
  modelKey: '',
  response: await opts.recordUpstreamLatency(Promise.resolve(synthetic405())),
});
