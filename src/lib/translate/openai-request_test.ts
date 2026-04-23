import { assertEquals } from "@std/assert";
import { translateToOpenAI } from "./openai.ts";

Deno.test("translateToOpenAI keeps tool_result and user text as separate chat messages", () => {
  const result = translateToOpenAI({
    model: "gpt-test",
    max_tokens: 256,
    messages: [{
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "result" },
        { type: "text", text: "Please continue." },
      ],
    }],
  });

  assertEquals(result.messages, [
    { role: "tool", tool_call_id: "toolu_1", content: "result" },
    { role: "user", content: "Please continue." },
  ]);
});
