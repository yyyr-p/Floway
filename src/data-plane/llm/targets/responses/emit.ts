import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../shared/protocol/responses.ts";
import { readUpstreamError } from "../../shared/errors/upstream-error.ts";
import {
  eventResult,
  internalErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { parseSSEStream } from "../../shared/stream/parse-sse.ts";
import { jsonFrame } from "../../shared/stream/types.ts";
import { runTargetInterceptors } from "../run-interceptors.ts";
import type { EmitInput, EmitResult, RawEmitResult } from "../emit-types.ts";
import {
  recordUpstreamHttpFailure,
  targetPerformanceContext,
  withUpstreamTelemetry,
} from "../telemetry.ts";
import { type SequencedResponseStreamEvent } from "./events/from-result.ts";
import { responsesStreamFramesToEvents } from "./events/from-stream.ts";
import { interceptorsForResponses } from "./interceptors/index.ts";
import type { ModelAccounting } from "../../../../repo/types.ts";

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

const responsesRawResultToProtocolResult = (
  result: RawEmitResult<ResponsesResult>,
): EmitResult<SequencedResponseStreamEvent> =>
  result.type === "events"
    ? eventResult(
      responsesStreamFramesToEvents(result.events),
      result.accounting,
      result.performance,
    )
    : result;

export const emitToResponses = async (
  input: EmitInput<ResponsesPayload>,
): Promise<EmitResult<SequencedResponseStreamEvent>> => {
  let accounting: ModelAccounting | undefined;
  try {
    input.payload.stream = true;

    const result = await runTargetInterceptors<
      EmitInput<ResponsesPayload>,
      ResponsesResult
    >(
      input,
      interceptorsForResponses(input),
      async () => {
        const upstreamStartedAt = performance.now();
        const { model: _model, ...body } = input.payload;
        const { response, modelKey } = await input.provider.callResponses(
          input.upstreamModel,
          body,
          input.downstreamAbortSignal,
        );
        accounting = {
          model: input.model,
          upstream: input.upstream,
          modelKey,
        };
        const perfContext = targetPerformanceContext(
          input,
          "responses",
          accounting,
        );

        if (!response.ok) {
          recordUpstreamHttpFailure(input, "responses", accounting);
          return {
            ...(await readUpstreamError(response)),
            performance: perfContext,
          };
        }
        if (!response.body) {
          return internalErrorResult(
            502,
            toInternalDebugError(
              new Error("No response body from upstream"),
              input.sourceApi,
              "responses",
            ),
            perfContext,
          );
        }

        if (isSSEResponse(response)) {
          return eventResult(
            withUpstreamTelemetry(
              parseSSEStream(response.body, {
                signal: input.downstreamAbortSignal,
              }),
              input,
              "responses",
              upstreamStartedAt,
              accounting,
            ),
            accounting,
            perfContext,
          );
        }

        return eventResult(
          withUpstreamTelemetry(
            (async function* () {
              yield jsonFrame(await response.json() as ResponsesResult);
            })(),
            input,
            "responses",
            upstreamStartedAt,
            accounting,
          ),
          accounting,
          perfContext,
        );
      },
    );

    return responsesRawResultToProtocolResult(result);
  } catch (error) {
    return internalErrorResult(
      502,
      toInternalDebugError(error, input.sourceApi, "responses"),
      accounting
        ? targetPerformanceContext(input, "responses", accounting)
        : undefined,
    );
  }
};
