import type {
  ResponsesPayload,
  ResponsesResult,
} from "../../../../lib/responses-types.ts";
import type { TargetInterceptor } from "../../run-interceptors.ts";
import type { EmitInput } from "../../emit-types.ts";
import { withConnectionMismatchRetried } from "./retry-connection-mismatch.ts";
import { withOutputItemIdsSynchronized } from "./synchronize-output-item-ids.ts";

export const responsesTargetInterceptors = [
  withConnectionMismatchRetried,
  withOutputItemIdsSynchronized,
] satisfies readonly TargetInterceptor<EmitInput<ResponsesPayload>, ResponsesResult>[];
