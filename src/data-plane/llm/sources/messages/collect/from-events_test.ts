import { assertEquals, assertFalse } from "@std/assert";
import {
  collectMessagesEventsToResponse,
  messagesResponseToSSEFrames,
} from "./from-events.ts";
import { sseFrame } from "../../../shared/stream/types.ts";

Deno.test("messagesResponseToSSEFrames omits signature deltas for text-only thinking blocks", () => {
  const frames = messagesResponseToSSEFrames({
    id: "msg_text_only_thinking",
    type: "message",
    role: "assistant",
    content: [{ type: "thinking", thinking: "trace" }],
    model: "claude-test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  });

  const payloads = frames.map((frame) =>
    frame.data === "[DONE]" ? frame.data : JSON.parse(frame.data)
  );

  assertFalse(payloads.some((payload) =>
    typeof payload === "object" &&
    payload.type === "content_block_delta" &&
    payload.delta.type === "signature_delta"
  ));
  assertEquals(
    payloads.filter((payload) =>
      typeof payload === "object" &&
      payload.type === "content_block_delta" &&
      payload.delta.type === "thinking_delta"
    ),
    [{
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "trace" },
    }],
  );
});

Deno.test("collectMessagesEventsToResponse preserves final message_delta input_tokens", async () => {
  async function* frames() {
    yield sseFrame(
      JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_late_usage",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-test",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      "message_start",
    );
    yield sseFrame(
      JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      "content_block_start",
    );
    yield sseFrame(
      JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "answer" },
      }),
      "content_block_delta",
    );
    yield sseFrame(
      JSON.stringify({ type: "content_block_stop", index: 0 }),
      "content_block_stop",
    );
    yield sseFrame(
      JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { input_tokens: 12, output_tokens: 4 },
      }),
      "message_delta",
    );
    yield sseFrame(
      JSON.stringify({ type: "message_stop" }),
      "message_stop",
    );
  }

  const response = await collectMessagesEventsToResponse(frames());

  assertEquals(response.usage, { input_tokens: 12, output_tokens: 4 });
});
