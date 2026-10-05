// The cyber-intercept gate itself. Called by each chat protocol's serve
// generate after candidate enumeration and before candidate dispatch.
//
// Contract:
//   - The gate runs at most one judge turn per request. Safe verdicts and
//     requests with no flag-on candidate bypass silently.
//   - Fail-closed: any judge failure — no judge model, unparseable output,
//     upstream error, thrown exception — counts as unsafe.
//   - mode=reject renders the protocol's reject envelope; mode=fallback
//     filters flag-on candidates out of the dispatch list and only errors
//     when that empties it (the caller must then not re-run the gate for the
//     filtered list).
//   - Only rejections are audited.
import { nanoid } from 'nanoid';

import type { ChatGatewayCtx } from '../gateway-ctx.ts';
import { serializePayload, type SerializedPayload, estimateMaxPayloadChars } from './payload.ts';
import { runCyberInterceptJudge } from './judge.ts';
import { loadCyberInterceptSettings, type CyberInterceptSettings } from './settings.ts';
import type { CyberInterceptAuditRecord } from '../../../../repo/types.ts';
import { getRepo } from '../../../../repo/index.ts';
import type { ModelCandidate, ExecuteResult } from '@floway-dev/provider';
import { providerModelOf } from '@floway-dev/provider';
import { getModelsFromProviders } from '../../../providers/catalog.ts';
import { listModelProviders } from '../../../providers/registry.ts';

export interface CyberInterceptGateInput {
  // The caller payload's model field — for Gemini this is the URL-carried id,
  // resolved by the HTTP entry, so every protocol passes its own value.
  readonly model: string;
  // The (unmutated) caller payload object itself, serialized for the judge.
  readonly payload: unknown;
  readonly ctx: ChatGatewayCtx;
  readonly candidates: readonly ModelCandidate[];
  readonly requestMethod: string;
  readonly requestPath: string;
}

export type CyberInterceptGateDecision<CandidatesT> =
  | { readonly kind: 'pass'; readonly candidates: CandidatesT }
  | { readonly kind: 'reject'; readonly reason: string };

// Load the gate's settings for a request, or null when the gate stands down:
// the request itself is the judge model's dispatched turn
// (`bypassCyberIntercept`), no candidate has the flag on, or the global
// switch / judge model is unconfigured. The per-protocol serve calls this
// first and only runs `runCyberInterceptGate` when it returns settings.
export const cyberInterceptGateSettingsFor = async (
  ctx: ChatGatewayCtx,
  candidates: readonly ModelCandidate[],
): Promise<CyberInterceptSettings | null> => {
  if (ctx.bypassCyberIntercept === true) return null;
  if (!candidates.some(candidate => providerModelOf(candidate).enabledFlags.has('cyber-intercept'))) return null;
  const settings = await loadCyberInterceptSettings();
  if (!settings.enabled || settings.judgeModelId === '') return null;
  return settings;
};

// The gate's full flow for one request. `renderReject` is the per-protocol
// envelope builder; the gate supplies only the verdict text.
export const runCyberInterceptGate = async (
  input: CyberInterceptGateInput,
  settings: CyberInterceptSettings,
  renderReject: (verdict: string) => ExecuteResult<never>,
): Promise<CyberInterceptGateDecision<readonly ModelCandidate[]>> => {
  const flagOnCandidates = input.candidates.filter(candidate => providerModelOf(candidate).enabledFlags.has('cyber-intercept'));
  if (flagOnCandidates.length === 0) return { kind: 'pass', candidates: input.candidates };

  const maxPayloadChars = await resolveMaxPayloadChars(settings.maxPayloadChars, settings.judgeModelId);
  const serialized: SerializedPayload = serializePayload(input.payload, maxPayloadChars);

  const outcome = await runCyberInterceptJudge(settings, serialized.text, input.ctx);

  if (outcome.verdict.unsafe) {
    const actionTaken = settings.mode === 'reject' ? 'rejected' : 'fallback-exhausted';
    // mode=fallback drains the flag-on candidates and only audits + rejects
    // when nothing is left to dispatch — a safe fallback pass is not a
    // rejection and produces no audit row.
    if (settings.mode === 'fallback') {
      const remaining = input.candidates.filter(candidate => !providerModelOf(candidate).enabledFlags.has('cyber-intercept'));
      if (remaining.length > 0) return { kind: 'pass', candidates: remaining };
    }
    const record: CyberInterceptAuditRecord = {
      id: nanoid(),
      createdAt: new Date().toISOString(),
      mode: settings.mode,
      actionTaken,
      reason: outcome.verdict.reason,
      judgeModelId: settings.judgeModelId,
      hitCandidates: flagOnCandidates.map(candidate => ({
        upstreamId: candidate.provider.upstreamId,
        modelId: candidate.model.id,
      })),
      payloadSha256: serialized.sha256,
      requestMethod: input.requestMethod,
      requestPath: input.requestPath,
    };
    await appendCyberInterceptAudit(record);
    return { kind: 'reject', reason: outcome.verdict.reason };
  }

  return { kind: 'pass', candidates: input.candidates };
};

// The audit row outlives the request, so the write rides the background
// scheduler (waitUntil on workerd / the event loop on Node) rather than
// being awaited — a blocked request must not be delayed further by its own
// audit row, and a repo hiccup must not turn a rendered 403 into a 502.
const appendCyberInterceptAudit = (record: CyberInterceptAuditRecord): void => {
  getRepo().cyberInterceptAuditLog.append(record).catch(error => {
    console.error('Failed to append cyber-intercept audit record:', error);
  });
};

// Estimate the fallback cap from the judge model's declared context window.
// Needs the catalog: the judge model row's `max_context_window_tokens`.
// Missing row or missing limit falls back to the fixed default. The operator's
// explicit setting short-circuits the catalog lookup.
const resolveMaxPayloadChars = async (configured: number | null, judgeModelId: string): Promise<number> => {
  if (configured !== null) return configured;
  const models = getModelsFromProviders(await listModelProviders(null), () => undefined).models;
  const judgeModel = models.find(model => model.id === judgeModelId);
  return estimateMaxPayloadChars(judgeModel?.limits.max_context_window_tokens);
};