import type { ChatCompletionResponse } from "../../../../lib/openai-types.ts";
import type { StreamExecuteResult } from "../../../shared/errors/result.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";

export const chatCompletionsSourceInterceptors = [] satisfies readonly SourceInterceptor<
  StreamExecuteResult<ChatCompletionResponse>
>[];
