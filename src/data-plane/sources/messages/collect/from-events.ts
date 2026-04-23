import type { AnthropicResponse } from "../../../../lib/anthropic-types.ts";
import { reassembleAnthropicSSE } from "../../../../lib/sse-reassemble.ts";
import {
  collectSSE,
  sseFramesToStream,
} from "../../../shared/stream/collect-sse.ts";
import {
  type SseFrame,
  sseFrame,
  type StreamFrame,
} from "../../../shared/stream/types.ts";

export const anthropicResponseToSSEFrames = (
  response: AnthropicResponse,
): SseFrame[] => {
  const frames: SseFrame[] = [
    sseFrame(
      JSON.stringify({
        type: "message_start",
        message: {
          id: response.id,
          type: response.type,
          role: response.role,
          content: [],
          model: response.model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...response.usage,
            output_tokens: 0,
          },
        },
      }),
      "message_start",
    ),
  ];

  response.content.forEach((block, index) => {
    if (block.type === "text") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }),
          "content_block_start",
        ),
      );

      if (block.text.length > 0) {
        frames.push(
          sseFrame(
            JSON.stringify({
              type: "content_block_delta",
              index,
              delta: { type: "text_delta", text: block.text },
            }),
            "content_block_delta",
          ),
        );
      }

      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    if (block.type === "tool_use") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: {},
            },
          }),
          "content_block_start",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_delta",
            index,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
          }),
          "content_block_delta",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    if (block.type === "thinking") {
      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_start",
            index,
            content_block: { type: "thinking", thinking: "" },
          }),
          "content_block_start",
        ),
      );

      if (block.thinking.length > 0) {
        frames.push(
          sseFrame(
            JSON.stringify({
              type: "content_block_delta",
              index,
              delta: { type: "thinking_delta", thinking: block.thinking },
            }),
            "content_block_delta",
          ),
        );
      }

      frames.push(
        sseFrame(
          JSON.stringify({
            type: "content_block_delta",
            index,
            delta: {
              type: "signature_delta",
              signature: block.signature || "",
            },
          }),
          "content_block_delta",
        ),
      );
      frames.push(
        sseFrame(
          JSON.stringify({ type: "content_block_stop", index }),
          "content_block_stop",
        ),
      );
      return;
    }

    frames.push(
      sseFrame(
        JSON.stringify({
          type: "content_block_start",
          index,
          content_block: { type: "redacted_thinking", data: block.data },
        }),
        "content_block_start",
      ),
    );
    frames.push(
      sseFrame(
        JSON.stringify({ type: "content_block_stop", index }),
        "content_block_stop",
      ),
    );
  });

  frames.push(
    sseFrame(
      JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: response.stop_reason,
          stop_sequence: response.stop_sequence,
        },
        usage: {
          output_tokens: response.usage.output_tokens,
          ...(response.usage.cache_creation_input_tokens !== undefined
            ? {
              cache_creation_input_tokens:
                response.usage.cache_creation_input_tokens,
            }
            : {}),
          ...(response.usage.cache_read_input_tokens !== undefined
            ? {
              cache_read_input_tokens: response.usage.cache_read_input_tokens,
            }
            : {}),
        },
      }),
      "message_delta",
    ),
    sseFrame(JSON.stringify({ type: "message_stop" }), "message_stop"),
  );

  return frames;
};

export const expandAnthropicFrames = async function* (
  frames: AsyncIterable<StreamFrame<AnthropicResponse>>,
): AsyncGenerator<SseFrame> {
  for await (const frame of frames) {
    if (frame.type === "sse") {
      yield frame;
      continue;
    }

    yield* anthropicResponseToSSEFrames(frame.data);
  }
};

export const collectAnthropicEventsToResponse = async (
  frames: AsyncIterable<StreamFrame<AnthropicResponse>>,
): Promise<AnthropicResponse> => {
  const collected = await collectSSE(expandAnthropicFrames(frames));
  return await reassembleAnthropicSSE(sseFramesToStream(collected));
};
