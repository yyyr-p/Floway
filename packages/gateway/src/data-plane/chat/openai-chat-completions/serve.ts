import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';
import { openaiChatCompletionsAttempt, openaiChatCompletionsTarget } from './attempt.ts';
import { renderOpenAIChatCompletionsCyberInterceptReject, renderOpenAIChatCompletionsFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/resolution.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { selectAffinityCandidates } from '../shared/affinity/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { cyberInterceptGateSettingsFor, runCyberInterceptGate } from '../shared/cyber-intercept/gate.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult } from '@floway-dev/provider';

export interface OpenAIChatCompletionsServeGenerateArgs {
  readonly payload: OpenAIChatCompletionsPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const openaiChatCompletionsServe = {
  generate: async (args: OpenAIChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const affinity = await analyzeOpenAIChatCompletionsAffinity(payload, ctx.affinity.codec);
    const viable = enumerated.filter(c => openaiChatCompletionsTarget.canServe(c.model.endpoints));
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderOpenAIChatCompletionsFailure(selection);
    if (selection.candidates.length === 0) return renderOpenAIChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams));

    // Cyber intercept: one judge turn before any dispatch, when at least one
    // candidate opted in. Reject renders the 403 envelope; fallback filters
    // the flag-on candidates out of the dispatch list.
    const cyberSettings = await cyberInterceptGateSettingsFor(ctx, selection.candidates);
    let dispatched = selection.candidates;
    if (cyberSettings !== null) {
      const gate = await runCyberInterceptGate({
        model: payload.model,
        payload: args.payload,
        ctx,
        candidates: selection.candidates,
        requestMethod: 'POST',
        requestPath: '/v1/chat/completions',
      }, cyberSettings, renderOpenAIChatCompletionsCyberInterceptReject);
      if (gate.kind === 'reject') return renderOpenAIChatCompletionsCyberInterceptReject(gate.reason);
      if (gate.candidates.length === 0) return renderOpenAIChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams));
      dispatched = gate.candidates;
    }

    // Try each affinity-selected candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim so the client still sees
    // real upstream telemetry rather than a synthetic envelope. Each attempt
    // stamps its private payload clone with the candidate's canonical model id
    // so aliases and prefixed ids resolve without mutating the caller payload.
    return await iterateCandidates(
      dispatched,
      'openaiChatCompletionsServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await openaiChatCompletionsAttempt.generate({ payload: selection.payloadFor(candidate), ctx, candidate, headers });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
  },
};
