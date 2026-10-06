import { geminiGenerateContentStatusForHttpStatus } from './errors.ts';
import { geminiGenerateContentCountTokensInterceptors, geminiGenerateContentInterceptors } from './interceptors/index.ts';
import { stripUnsupportedPartFieldsFromPayload } from './interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './interceptors/strip-unsupported-tools.ts';
import { createGeminiGenerateContentBillableUsageReader } from './usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerStreamResultToExecuteResult } from '../shared/provider-stream-result.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { captureFromDump, traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { type ModelCandidate, plainResult, type ExecuteResult, type GeminiGenerateContentInvocation, type PlainResult, providerModelOf } from '@floway-dev/provider';
import { translateGeminiGenerateContentViaOpenAIChatCompletions, translateGeminiGenerateContentViaAnthropicMessages, translateGeminiGenerateContentViaOpenAIResponses } from '@floway-dev/translate';

// `/v1beta/models/{id}:generateContent` prefers a native Gemini generateContent
// target — the gemini / antigravity providers speak it directly — then falls
// back to the translated OpenAI Chat Completions, Anthropic Messages, and
// OpenAI Responses paths.
export const geminiGenerateContentGenerateTarget = chatTargetPicker(['geminiGenerateContent', 'openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);
export const geminiGenerateContentCountTokensTarget = chatTargetPicker(['geminiGenerateContent', 'anthropicMessages']);

export interface GeminiGenerateContentAttemptGenerateArgs {
  readonly payload: GeminiGenerateContentPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export interface GeminiGenerateContentAttemptCountTokensArgs {
  readonly payload: GeminiGenerateContentPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export const geminiGenerateContentAttempt = {
  generate: async (args: GeminiGenerateContentAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>>> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = structuredClone(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiGenerateContentGenerateTarget.pick(candidate.model.endpoints);
    const invocation: GeminiGenerateContentInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiGenerateContentInterceptors, async () => {
      // The dispatch threads each branch through `traverseTranslation` (or the
      // native call) so each inner attempt owns its own interceptor chain and
      // rewrite.
      if (targetApi === 'geminiGenerateContent') {
        const providerResult = await candidate.provider.instance.callGeminiGenerateContent(
          providerModelOf(candidate),
          invocation.payload,
          ctx.abortSignal,
          buildUpstreamCallOptions(candidate, ctx, invocation.headers),
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate, targetApi, ctx, createGeminiGenerateContentBillableUsageReader());
      }
      const transCtx = {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      };
      if (targetApi === 'anthropicMessages') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiGenerateContentViaAnthropicMessages(p, transCtx),
          translated => anthropicMessagesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
          }),
          captureFromDump(ctx.dump, targetApi),
        );
      }
      if (targetApi === 'openaiResponses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiGenerateContentViaOpenAIResponses(p, transCtx),
          translated => openaiResponsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
          captureFromDump(ctx.dump, targetApi),
        );
      }
      if (targetApi === 'openaiChatCompletions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiGenerateContentViaOpenAIChatCompletions(p, transCtx),
          translated => openaiChatCompletionsAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
          captureFromDump(ctx.dump, targetApi),
        );
      }
      throw new Error(`geminiGenerateContentAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },

  countTokens: async (args: GeminiGenerateContentAttemptCountTokensArgs): Promise<PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = structuredClone(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiGenerateContentCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: GeminiGenerateContentInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiGenerateContentCountTokensInterceptors, async () => {
      // A native geminiGenerateContent target relays the upstream countTokens
      // Response verbatim — the envelope is already `{ totalTokens }` on that
      // wire. A translated Anthropic Messages target reshapes the count_tokens
      // reply instead. The shipped Gemini generateContent interceptors that
      // mutate the payload pre-dispatch cannot run via the countTokens
      // interceptor list — the post-`run()` ones inspect event streams the
      // result type cannot carry — so the payload-mutators are applied inline
      // here before dispatch; the attempt-owned payload clone keeps the
      // caller's source intact.
      const cleaned = invocation.payload;
      stripUnsupportedPartFieldsFromPayload(cleaned);
      stripUnsupportedToolsFromPayload(cleaned);
      delete cleaned.safetySettings;
      if (targetApi === 'geminiGenerateContent') {
        const { response } = await candidate.provider.instance.callGeminiGenerateContentCountTokens(
          providerModelOf(candidate),
          cleaned,
          ctx.abortSignal,
          buildUpstreamCallOptions(candidate, ctx, invocation.headers),
        );
        return await relayGeminiGenerateContentCountResult(response, candidate.provider.upstreamId);
      }
      const transCtx = {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      };
      const trip = await translateGeminiGenerateContentViaAnthropicMessages(cleaned, transCtx);
      const { stream: _stream, ...target } = trip.target;
      const anthropicMessagesResult = await anthropicMessagesAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      });
      return reshapeAnthropicMessagesCountAsGeminiGenerateContent(anthropicMessagesResult);
    });
  },
};

// Native countTokens dispatch: a 2xx relays the upstream body verbatim (it is
// already the Gemini `{ totalTokens }` envelope); anything else is surfaced as
// the Google-RPC envelope so the caller sees a typed Gemini failure.
const relayGeminiGenerateContentCountResult = async (response: Response, upstreamId: string): Promise<PlainResult> => {
  const relayed = await plainResultFromResponse(response, upstreamId);
  if (relayed.status >= 200 && relayed.status < 300) return relayed;
  return geminiGenerateContentErrorPlainResult(relayed.status, new TextDecoder().decode(relayed.body) || 'Upstream token counting request failed.', upstreamId);
};

// Reshape the Anthropic Messages count_tokens body into the Gemini generateContent `{ totalTokens }`
// envelope. The upstream body shape is provider-specific: Anthropic emits
// `{ input_tokens }`, Copilot's translated count emits `{ total_tokens }`;
// either is accepted. A missing or non-numeric figure is surfaced as a
// 502 Google-RPC error so the caller sees a typed Gemini generateContent failure rather
// than a passthrough of the upstream shape.
const reshapeAnthropicMessagesCountAsGeminiGenerateContent = (anthropicMessagesResult: PlainResult): PlainResult => {
  if (anthropicMessagesResult.status !== 200) {
    // Empty upstream bodies fall back to a fixed message so the Google-RPC envelope is never empty.
    const text = new TextDecoder().decode(anthropicMessagesResult.body);
    return geminiGenerateContentErrorPlainResult(anthropicMessagesResult.status, text || 'Upstream token counting request failed.', anthropicMessagesResult.upstreamId);
  }
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(anthropicMessagesResult.body)); } catch {}
  const upstreamTokenCounts = decoded && typeof decoded === 'object'
    ? decoded as { input_tokens?: unknown; total_tokens?: unknown }
    : {};
  const totalTokens = typeof upstreamTokenCounts.input_tokens === 'number'
    ? upstreamTokenCounts.input_tokens
    : typeof upstreamTokenCounts.total_tokens === 'number'
      ? upstreamTokenCounts.total_tokens
      : null;
  if (totalTokens === null) {
    return geminiGenerateContentInternalPlainResult(502, new Error('Invalid upstream token counting response.'));
  }
  return plainResult(
    200,
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode(JSON.stringify({ totalTokens })),
    anthropicMessagesResult.upstreamId,
  );
};

const geminiGenerateContentErrorPlainResult = (status: number, message: string, upstream?: string): PlainResult => plainResult(
  status,
  new Headers({ 'content-type': 'application/json' }),
  new TextEncoder().encode(JSON.stringify({ error: { code: status, message, status: geminiGenerateContentStatusForHttpStatus(status) } })),
  upstream,
);

const geminiGenerateContentInternalPlainResult = (status: number, error: Error): PlainResult => plainResult(
  status,
  new Headers({ 'content-type': 'application/json' }),
  new TextEncoder().encode(JSON.stringify({
    error: {
      code: status,
      message: error.message,
      status: geminiGenerateContentStatusForHttpStatus(status),
      type: 'internal_error',
      name: error.name,
      stack: error.stack,
    },
  })),
);
