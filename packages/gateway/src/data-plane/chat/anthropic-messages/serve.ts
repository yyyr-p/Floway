import { analyzeAnthropicMessagesAffinity } from './affinity/ingress.ts';
import { anthropicMessagesAttempt, anthropicMessagesGenerateTarget, anthropicMessagesCountTokensTarget } from './attempt.ts';
import { renderAnthropicMessagesCyberInterceptReject, renderAnthropicMessagesFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/resolution.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { selectAffinityCandidates } from '../shared/affinity/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { cyberInterceptGateSettingsFor, runCyberInterceptGate } from '../shared/cyber-intercept/gate.ts';
import { parseAnthropicBetaHeader, type AnthropicMessagesPayload, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface AnthropicMessagesServeGenerateArgs {
  readonly payload: AnthropicMessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export interface AnthropicMessagesServeCountTokensArgs {
  readonly payload: AnthropicMessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const anthropicMessagesServe = {
  generate: async (args: AnthropicMessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const anthropicBeta = parseAnthropicBetaHeader(headers.get('anthropic-beta'));
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const affinity = await analyzeAnthropicMessagesAffinity(payload, ctx.affinity.codec);
    const viable = enumerated.filter(c => anthropicMessagesGenerateTarget.canServe(c.model.endpoints));
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderAnthropicMessagesFailure(selection, 'generate');
    if (selection.candidates.length === 0) return renderAnthropicMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'generate');

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
        requestPath: '/v1/messages',
      }, cyberSettings, renderAnthropicMessagesCyberInterceptReject);
      if (gate.kind === 'reject') return renderAnthropicMessagesCyberInterceptReject(gate.reason);
      if (gate.candidates.length === 0) return renderAnthropicMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'generate');
      dispatched = gate.candidates;
    }

    // Try each affinity-selected candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim. Each attempt stamps its
    // private payload clone with the candidate's canonical model id.
    return await iterateCandidates(
      dispatched,
      'anthropicMessagesServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await anthropicMessagesAttempt.generate({ payload: selection.payloadFor(candidate), ctx, candidate, headers, anthropicBeta });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
  },

  countTokens: async (args: AnthropicMessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, headers } = args;
    const anthropicBeta = parseAnthropicBetaHeader(headers.get('anthropic-beta'));
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const affinity = await analyzeAnthropicMessagesAffinity(payload, ctx.affinity.codec);
    const viable = enumerated.filter(c => anthropicMessagesCountTokensTarget.canServe(c.model.endpoints));
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderAnthropicMessagesFailure(selection, 'countTokens');
    if (selection.candidates.length === 0) return renderAnthropicMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'countTokens');

    return await iterateCandidates(
      selection.candidates,
      'anthropicMessagesServe.countTokens',
      ctx,
      'chat',
      candidate => anthropicMessagesAttempt.countTokens({ payload: selection.payloadFor(candidate), ctx, candidate, headers, anthropicBeta }),
    );
  },
};
