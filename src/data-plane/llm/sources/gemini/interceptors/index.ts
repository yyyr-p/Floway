import type { GeminiStreamEvent } from "../../../../../lib/gemini-types.ts";
import type { StreamExecuteResult } from "../../../shared/errors/result.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";

export const geminiSourceInterceptors = [] satisfies readonly SourceInterceptor<
  StreamExecuteResult<GeminiStreamEvent>
>[];
