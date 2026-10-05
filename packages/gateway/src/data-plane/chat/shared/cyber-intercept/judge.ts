// The judge-model call behind the cyber-intercept gate.
//
// The judge request is synthesized as an OpenAI Chat Completions payload and
// dispatched through Floway's own candidate machinery — `enumerateModelCandidates`
// (which resolves alias targets, so a judgeModelId configured as an alias gets
// its fallback for free), the chat target picker, `iterateCandidates`, and the
// openai-chat-completions attempt with its interceptor chain and translation
// layer. One gate run issues exactly one judged turn regardless of which
// upstream answers.
//
// Two properties make the recursion and scope safe:
//   - System-internal context: the judge ctx carries `upstreamIds: null`, so
//     `listModelProviders` sees every enabled upstream regardless of the
//     caller's user/apiKey upstream cap.
//   - `bypassCyberIntercept`: the gate checks this flag and stands down, so
//     the judged turn cannot recurse into itself.
import { analyzeOpenAIChatCompletionsAffinity } from '../../openai-chat-completions/affinity/ingress.ts';
import { openaiChatCompletionsAttempt, openaiChatCompletionsTarget } from '../../openai-chat-completions/attempt.ts';
import { collectOpenAIChatCompletionsProtocolEventsToResult } from '@floway-dev/protocols/openai-chat-completions';
import { enumerateModelCandidates } from '../../../providers/resolution.ts';
import { iterateCandidates } from '../../../shared/iterate-candidates.ts';
import { selectAffinityCandidates } from '../affinity/index.ts';
import type { ChatGatewayCtx } from '../gateway-ctx.ts';
import { settle } from '../../../shared/telemetry/settle.ts';
import { tokenUsageFromBillableUsage } from '../../../shared/telemetry/usage.ts';
import type { InternalDebugError } from '@floway-dev/provider';
import { toInternalDebugError, type ExecuteResult, type ModelCandidate } from '@floway-dev/provider';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import type { CyberInterceptSettings } from './settings.ts';
import { JUDGE_PAYLOAD_CLOSE_TAG, JUDGE_PAYLOAD_OPEN_TAG } from './settings.ts';
import type { CyberInterceptVerdict } from './verdict.ts';
import { parseCyberInterceptVerdict } from './verdict.ts';

// How the judge call resolved. `judged` carries the parsed verdict plus the
// candidate that produced it (for audit attribution), or the internal-error
// result that replaced it under fail-closed.
export type CyberInterceptJudgeOutcome =
  | { readonly kind: 'judged'; readonly verdict: CyberInterceptVerdict; readonly judgeCandidate: ModelCandidate | null; readonly internalError: InternalDebugError | null }
  | { readonly kind: 'no-judge-model'; readonly verdict: CyberInterceptVerdict };

export const JUDGE_UNAVAILABLE_REASON = 'judge model unavailable (fail-closed)';

const judgePayload = (settings: CyberInterceptSettings, payloadText: string): OpenAIChatCompletionsPayload => ({
  model: settings.judgeModelId,
  stream: false,
  messages: [
    ...(settings.prefixPrompt === '' ? [] : [{ role: 'system' as const, content: settings.prefixPrompt }]),
    {
      role: 'user' as const,
      content: `${JUDGE_PAYLOAD_OPEN_TAG}${payloadText}${JUDGE_PAYLOAD_CLOSE_TAG}${settings.suffixPrompt}`,
    },
  ],
});

export const runCyberInterceptJudge = async (
  settings: CyberInterceptSettings,
  payloadText: string,
  parentCtx: ChatGatewayCtx,
): Promise<CyberInterceptJudgeOutcome> => {
  const payload = judgePayload(settings, payloadText);
  const judgeCtx: ChatGatewayCtx = { ...parentCtx, upstreamIds: null, bypassCyberIntercept: true };
  try {
    const { candidates } = await enumerateModelCandidates({
      upstreamIds: null,
      model: settings.judgeModelId,
      kind: 'chat',
      scheduler: judgeCtx.backgroundScheduler,
      runtimeLocation: judgeCtx.runtimeLocation,
    });
    const viable = candidates.filter(c => openaiChatCompletionsTarget.canServe(c.model.endpoints));
    if (viable.length === 0) {
      // The judge model id never matched a chat-capable model anywhere.
      return { kind: 'no-judge-model', verdict: { unsafe: true, reason: JUDGE_UNAVAILABLE_REASON } };
    }
    const affinity = await analyzeOpenAIChatCompletionsAffinity(payload, judgeCtx.affinity.codec);
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) {
      return { kind: 'no-judge-model', verdict: { unsafe: true, reason: JUDGE_UNAVAILABLE_REASON } };
    }
    // The judge owns its own headers: the caller's inbound headers must not
    // leak to the judge upstream, so an empty set is built per attempt.
    let judgedCandidate: ModelCandidate | null = null;
    const result = await iterateCandidates(
      selection.candidates,
      'runCyberInterceptJudge',
      judgeCtx,
      'chat',
      async candidate => {
        const attemptResult = await openaiChatCompletionsAttempt.generate({ payload, ctx: judgeCtx, candidate, headers: new Headers() });
        if (attemptResult.type === 'events') judgedCandidate = candidate;
        return attemptResult;
      },
    );
    if (result.type !== 'events') {
      // api-error / internal-error across every judge candidate — fail-closed.
      const internalError: InternalDebugError | null = result.type === 'internal-error' ? result.error : null;
      return {
        kind: 'judged',
        verdict: { unsafe: true, reason: JUDGE_UNAVAILABLE_REASON },
        judgeCandidate: null,
        internalError,
      };
    }
    const collected = await collectOpenAIChatCompletionsProtocolEventsToResult(result.events);
    // The judge's own usage settles into the usage system against the caller's
    // key — the judged turn is a real billed turn on the judge upstream.
    const metadata = (await result.finalMetadata)!;
    settle(judgeCtx, result.performance, metadata.modelIdentity, tokenUsageFromBillableUsage(metadata.billableUsage), false);
    const output = collected.choices[0]?.message.content ?? '';
    return {
      kind: 'judged',
      verdict: parseCyberInterceptVerdict(output),
      judgeCandidate: judgedCandidate,
      internalError: null,
    };
  } catch (error) {
    // A throw escaping the judge pipeline (dial failure, translation bug,
    // protocol edge) is fail-closed, not a 502: the gate's contract is that
    // anything other than an explicit SAFE verdict blocks.
    return { kind: 'judged', verdict: { unsafe: true, reason: JUDGE_UNAVAILABLE_REASON }, judgeCandidate: null, internalError: toInternalDebugError(error) };
  }
};