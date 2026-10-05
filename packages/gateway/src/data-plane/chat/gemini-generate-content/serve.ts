import { analyzeGeminiGenerateContentAffinity } from './affinity/ingress.ts';
import { geminiGenerateContentAttempt, geminiGenerateContentCountTokensTarget, geminiGenerateContentGenerateTarget } from './attempt.ts';
import { renderGeminiGenerateContentCyberInterceptReject, renderGeminiGenerateContentFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/resolution.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { selectAffinityCandidates } from '../shared/affinity/index.ts';
import { cyberInterceptGateSettingsFor, runCyberInterceptGate } from '../shared/cyber-intercept/gate.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface GeminiGenerateContentServeGenerateArgs {
  readonly payload: GeminiGenerateContentPayload;
  readonly ctx: ChatGatewayCtx;
  // Per-request model id (Gemini generateContent carries it in the URL path, not the body),
  // resolved by the HTTP entry and threaded through here so candidate
  // enumeration and failure rendering all see the same value.
  readonly model: string;
  readonly headers: Headers;
}

export interface GeminiGenerateContentServeCountTokensArgs {
  readonly payload: GeminiGenerateContentPayload;
  readonly ctx: ChatGatewayCtx;
  readonly model: string;
  readonly headers: Headers;
}

export const geminiGenerateContentServe = {
  generate: async (args: GeminiGenerateContentServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>>> => {
    const { payload, ctx, model, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const affinity = await analyzeGeminiGenerateContentAffinity(payload, ctx.affinity.codec);
    const viable = enumerated.filter(c => geminiGenerateContentGenerateTarget.canServe(c.model.endpoints));
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderGeminiGenerateContentFailure(selection, 'generate');
    if (selection.candidates.length === 0) return renderGeminiGenerateContentFailure(noViableCandidateFailure(sawModel, model, failedUpstreams), 'generate');

    // Cyber intercept: one judge turn before any dispatch, when at least one
    // candidate opted in. Reject renders the 403 envelope; fallback filters
    // the flag-on candidates out of the dispatch list.
    const cyberSettings = await cyberInterceptGateSettingsFor(ctx, selection.candidates);
    let dispatched = selection.candidates;
    if (cyberSettings !== null) {
      const gate = await runCyberInterceptGate({
        model,
        payload: args.payload,
        ctx,
        candidates: selection.candidates,
        requestMethod: 'POST',
        requestPath: '/v1beta/models/generateContent',
      }, cyberSettings);
      if (gate.kind === 'reject') return renderGeminiGenerateContentCyberInterceptReject(gate.reason);
      if (gate.candidates.length === 0) return renderGeminiGenerateContentFailure(noViableCandidateFailure(sawModel, model, failedUpstreams), 'generate');
      dispatched = gate.candidates;
    }

    // Gemini generateContent carries the requested model in its URL, so affinity preparation
    // owns each candidate payload while dispatch uses the candidate's canonical model.
    return await iterateCandidates(
      dispatched,
      'geminiGenerateContentServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await geminiGenerateContentAttempt.generate({ payload: selection.payloadFor(candidate), ctx, candidate, headers });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
  },

  countTokens: async (args: GeminiGenerateContentServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>> | PlainResult> => {
    const { payload, ctx, model, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const affinity = await analyzeGeminiGenerateContentAffinity(payload, ctx.affinity.codec);
    const viable = enumerated.filter(c => geminiGenerateContentCountTokensTarget.canServe(c.model.endpoints));
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderGeminiGenerateContentFailure(selection, 'countTokens');
    if (selection.candidates.length === 0) return renderGeminiGenerateContentFailure(noViableCandidateFailure(sawModel, model, failedUpstreams), 'countTokens');

    return await iterateCandidates(
      selection.candidates,
      'geminiGenerateContentServe.countTokens',
      ctx,
      'chat',
      candidate => geminiGenerateContentAttempt.countTokens({ payload: selection.payloadFor(candidate), ctx, candidate, headers }),
    );
  },
};
