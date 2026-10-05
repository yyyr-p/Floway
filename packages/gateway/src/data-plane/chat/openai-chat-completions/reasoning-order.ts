import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsDelta, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ExecuteResult } from '@floway-dev/provider';

type OpenAIChatCompletionsFrame = ProtocolFrame<OpenAIChatCompletionsStreamEvent>;
type OpenAIChatCompletionsChoice = OpenAIChatCompletionsStreamEvent['choices'][number];

const hasReasoning = (delta: OpenAIChatCompletionsDelta): boolean =>
  [delta.reasoning_text, delta.reasoning_content, delta.reasoning]
    .some(value => typeof value === 'string' && value.length > 0)
  || delta.reasoning_opaque != null
  || (delta.reasoning_items?.length ?? 0) > 0;

const hasDeltaFields = (delta: OpenAIChatCompletionsDelta): boolean => Object.keys(delta).length > 0;

const splitReasoningFromChoice = (choice: OpenAIChatCompletionsChoice): {
  reasoning?: OpenAIChatCompletionsChoice;
  content?: OpenAIChatCompletionsChoice;
} => {
  if (!hasReasoning(choice.delta)) return { content: choice };

  const {
    reasoning_text: reasoningText,
    reasoning_content: reasoningContent,
    reasoning,
    reasoning_opaque: reasoningOpaque,
    reasoning_items: reasoningItems,
    ...contentDelta
  } = choice.delta;
  const reasoningDelta: OpenAIChatCompletionsDelta = {
    ...(reasoningText !== undefined ? { reasoning_text: reasoningText } : {}),
    ...(reasoningContent !== undefined ? { reasoning_content: reasoningContent } : {}),
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(reasoningOpaque !== undefined ? { reasoning_opaque: reasoningOpaque } : {}),
    ...(reasoningItems !== undefined ? { reasoning_items: reasoningItems } : {}),
  };

  return {
    reasoning: { ...choice, delta: reasoningDelta, finish_reason: null },
    ...(hasDeltaFields(contentDelta) || choice.finish_reason !== null
      ? { content: { ...choice, delta: contentDelta, finish_reason: choice.finish_reason } }
      : {}),
  };
};

const splitReasoningFromEvent = (event: OpenAIChatCompletionsStreamEvent): {
  reasoning?: OpenAIChatCompletionsStreamEvent;
  content?: OpenAIChatCompletionsStreamEvent;
} => {
  const reasoningChoices: OpenAIChatCompletionsChoice[] = [];
  const contentChoices: OpenAIChatCompletionsChoice[] = [];

  for (const choice of event.choices) {
    const split = splitReasoningFromChoice(choice);
    if (split.reasoning) reasoningChoices.push(split.reasoning);
    if (split.content) contentChoices.push(split.content);
  }

  if (reasoningChoices.length === 0) return { content: event };

  return {
    reasoning: {
      ...event,
      // Usage belongs to the original chunk exactly once; keep it with body or
      // terminal data when present, otherwise the reasoning frame carries it.
      ...(contentChoices.length > 0 ? { usage: undefined } : {}),
      choices: reasoningChoices,
    },
    ...(contentChoices.length > 0 ? { content: { ...event, choices: contentChoices } } : {}),
  };
};

const reasoningBeforeContentFrames = async function* (
  frames: AsyncIterable<OpenAIChatCompletionsFrame>,
): AsyncGenerator<OpenAIChatCompletionsFrame> {
  const reasoningFrames: OpenAIChatCompletionsFrame[] = [];
  const contentFrames: OpenAIChatCompletionsFrame[] = [];
  let terminalFrame: OpenAIChatCompletionsFrame | undefined;
  let failure: { error: unknown } | undefined;

  // Chat Completions has no event that closes the reasoning phase. Buffering
  // to the terminal frame is the only protocol-neutral way to move arbitrarily
  // late reasoning ahead of text without dropping or guessing at its boundary.
  try {
    for await (const frame of frames) {
      if (frame.type === 'done') {
        terminalFrame = frame;
        break;
      }

      const split = splitReasoningFromEvent(frame.event);
      if (split.reasoning) reasoningFrames.push(eventFrame(split.reasoning));
      if (split.content) contentFrames.push(eventFrame(split.content));
    }
  } catch (error) {
    failure = { error };
  }

  yield* reasoningFrames;
  yield* contentFrames;
  // Flush received partial output before propagating the original failure;
  // an interrupted upstream must not become a successful terminal frame.
  if (failure) throw failure.error;
  if (terminalFrame) yield terminalFrame;
};

export const withOpenAIChatCompletionsReasoningBeforeContent = (
  result: ExecuteResult<OpenAIChatCompletionsFrame>,
): ExecuteResult<OpenAIChatCompletionsFrame> => {
  if (result.type !== 'events') return result;
  return { ...result, events: reasoningBeforeContentFrames(result.events) };
};
