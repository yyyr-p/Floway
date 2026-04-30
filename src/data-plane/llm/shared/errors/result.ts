import type { InternalDebugError } from "./internal-debug-error.ts";
import type { ProtocolFrame } from "../stream/types.ts";

export interface EventResult<T> {
  type: "events";
  events: AsyncIterable<T>;
  usageModel?: string;
}

export interface UpstreamErrorResult {
  type: "upstream-error";
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export interface InternalErrorResult {
  type: "internal-error";
  status: number;
  error: InternalDebugError;
}

export type ExecuteResult<T> =
  | EventResult<T>
  | UpstreamErrorResult
  | InternalErrorResult;

export type StreamExecuteResult<TEvent> = ExecuteResult<ProtocolFrame<TEvent>>;

export const eventResult = <T>(
  events: AsyncIterable<T>,
  options: { usageModel?: string } = {},
): EventResult<T> => {
  const result: EventResult<T> = { type: "events", events };
  if (options.usageModel !== undefined) result.usageModel = options.usageModel;
  return result;
};

export const internalErrorResult = (
  status: number,
  error: InternalDebugError,
): InternalErrorResult => ({
  type: "internal-error",
  status,
  error,
});
