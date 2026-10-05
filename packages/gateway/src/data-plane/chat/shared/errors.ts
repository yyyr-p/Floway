import { usageLimitDenialMessage, type UsageLimitAdmission } from '../../shared/usage-limit-admission.ts';
import type { ApiErrorResult, PerformanceTelemetryContext } from '@floway-dev/provider';

// Failures a chat protocol can render before reaching an upstream; unexpected
// throws bubble as-is. `failedUpstreams` on model-{missing,unsupported}
// carries upstream names with a recorded catalog-refresh failure. The error
// may predate this resolution and may accompany a usable last-known-good
// catalog; empty means no consulted snapshot records such a failure.
export type ChatServeFailure =
  | { readonly kind: 'model-missing'; readonly model: string; readonly failedUpstreams: readonly string[] }
  | { readonly kind: 'model-unsupported'; readonly model: string; readonly failedUpstreams: readonly string[] }
  | { readonly kind: 'routing-unavailable'; readonly message: string };

class ChatServeFailureError<TFailure extends { readonly kind: string }> extends Error {
  readonly failure: TFailure;

  constructor(failure: TFailure) {
    super(`ChatServeFailure: ${failure.kind}`);
    this.failure = failure;
  }
}

export const throwChatServeFailure = <TFailure extends { readonly kind: string }>(failure: TFailure): never => {
  throw new ChatServeFailureError(failure);
};

export const tryCatchChatServeFailure = <TFailure extends { readonly kind: string } = ChatServeFailure>(error: unknown): TFailure | null =>
  error instanceof ChatServeFailureError ? error.failure as TFailure : null;

export const openAiErrorResult = (
  status: number,
  message: string,
  extra?: { readonly param: string; readonly code: string | null },
  performance?: PerformanceTelemetryContext,
  errorType = 'invalid_request_error',
): ApiErrorResult => ({
  type: 'api-error',
  source: 'gateway',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify({
    error: { message, type: errorType, ...extra },
  })),
  ...(performance ? { performance } : {}),
}) satisfies ApiErrorResult;

export const openAiUsageLimitErrorResult = (admission: Exclude<UsageLimitAdmission, { readonly ok: true }>): ApiErrorResult =>
  openAiErrorResult(
    admission.reason === 'storage' ? 503 : 429,
    admission.reason === 'storage' ? usageLimitDenialMessage(admission.reason, admission.error) : usageLimitDenialMessage(admission.reason),
    { param: 'usage', code: admission.reason === 'storage' ? 'usage_limit_storage_unavailable' : 'usage_limit_exceeded' },
    undefined,
    admission.reason === 'storage' ? 'server_error' : 'rate_limit_error',
  );

// Builds the failure value every serve dispatches with after `canServe` has
// dropped every candidate: `sawModel=true` means the inbound id exists in
// some upstream's catalog but no upstream wire reaches it for this protocol,
// rendered as 400 model-unsupported; `sawModel=false` means no upstream knows
// the id at all, rendered as 404 model-missing. The per-protocol failure
// renderer turns the value into its own envelope shape.
export const noViableCandidateFailure = (
  sawModel: boolean,
  model: string,
  failedUpstreams: readonly string[],
): ChatServeFailure =>
  sawModel
    ? { kind: 'model-unsupported', model, failedUpstreams }
    : { kind: 'model-missing', model, failedUpstreams };
