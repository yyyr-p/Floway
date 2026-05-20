import { ModelsFetchError } from "../../../models/cache.ts";
import type { PerformanceTelemetryContext } from "../../../shared/performance/telemetry.ts";
import type { UpstreamErrorResult } from "./result.ts";

export const modelLoadErrorResult = (
  error: unknown,
  performance?: PerformanceTelemetryContext,
): UpstreamErrorResult => {
  if (!(error instanceof ModelsFetchError)) throw error;

  return {
    type: "upstream-error",
    status: error.status,
    headers: new Headers(error.headers),
    body: new TextEncoder().encode(error.body),
    ...(performance ? { performance } : {}),
  };
};
