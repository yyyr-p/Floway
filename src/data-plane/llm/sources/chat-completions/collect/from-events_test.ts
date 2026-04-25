import { assertEquals } from "@std/assert";
import { chatCompletionToSSEFrames } from "./from-events.ts";

Deno.test("chatCompletionToSSEFrames preserves reasoning_items on expanded non-stream responses", () => {
  const frames = chatCompletionToSSEFrames({
    id: "chatcmpl_reasoning_items",
    object: "chat.completion",
    created: 1,
    model: "gpt-test",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: "answer",
        reasoning_items: [{
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "trace" }],
          encrypted_content: "enc_1",
        }],
      } as never,
      finish_reason: "stop",
    }],
  });

  const payloads = frames
    .map((frame) => frame.data)
    .filter((data) => data !== "[DONE]")
    .map((data) => JSON.parse(data));

  assertEquals(payloads[1].choices[0].delta.reasoning_items, [{
    type: "reasoning",
    id: "rs_1",
    summary: [{ type: "summary_text", text: "trace" }],
    encrypted_content: "enc_1",
  }]);
});
