import { expect, test } from 'vitest';

import { withOpenAIChatCompletionsReasoningBeforeContent } from '../../../../src/data-plane/chat/openai-chat-completions/reasoning-order.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsDelta, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { eventResult } from '@floway-dev/provider';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

type Frame = ProtocolFrame<OpenAIChatCompletionsStreamEvent>;

const chunk = (delta: OpenAIChatCompletionsDelta): Frame => eventFrame({
  id: 'chat_order',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'test-model',
  choices: [{ index: 0, delta, finish_reason: null }],
});

const ordered = (frames: AsyncIterable<Frame>): AsyncIterable<Frame> => {
  const result = withOpenAIChatCompletionsReasoningBeforeContent(eventResult(frames, testTelemetryModelIdentity));
  if (result.type !== 'events') throw new Error('expected events result');
  return result.events;
};

const frames = async function* (...values: Frame[]): AsyncGenerator<Frame> {
  yield* values;
};

test('buffers text until the complete stream can put late reasoning first', async () => {
  let finish!: () => void;
  let waiting!: () => void;
  const terminalGate = new Promise<void>(resolve => { finish = resolve; });
  const upstreamWaiting = new Promise<void>(resolve => { waiting = resolve; });
  const text = chunk({ content: 'answer' });
  const reasoning = chunk({ reasoning_content: 'late thought' });
  const iterator = ordered((async function* () {
    yield text;
    waiting();
    await terminalGate;
    yield reasoning;
    yield doneFrame();
  })())[Symbol.asyncIterator]();
  let firstDelivered = false;
  const first = iterator.next().then(value => {
    firstDelivered = true;
    return value;
  });

  await upstreamWaiting;
  expect(firstDelivered).toBe(false);
  finish();
  expect(await first).toEqual({ done: false, value: reasoning });
  expect(await iterator.next()).toEqual({ done: false, value: text });
  expect(await iterator.next()).toEqual({ done: false, value: doneFrame() });
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

test.each([new Error('upstream disconnected'), undefined, 'upstream failure'])(
  'flushes ordered partial output before rethrowing the original failure %s',
  async error => {
    const text = chunk({ content: 'partial answer' });
    const reasoning = chunk({ reasoning_content: 'late partial thought' });
    const iterator = ordered((async function* () {
      yield text;
      yield reasoning;
      throw error;
    })())[Symbol.asyncIterator]();

    expect(await iterator.next()).toEqual({ done: false, value: reasoning });
    expect(await iterator.next()).toEqual({ done: false, value: text });
    await expect(iterator.next()).rejects.toBe(error);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  },
);

test('propagates an early upstream error without producing output or a terminal frame', async () => {
  const error = new Error('upstream failed before output');
  const iterator = ordered((async function* () {
    yield* [];
    throw error;
  })())[Symbol.asyncIterator]();

  await expect(iterator.next()).rejects.toBe(error);
  expect(await iterator.next()).toEqual({ done: true, value: undefined });
});

test('does not manufacture a done frame when a finite stream omits it', async () => {
  const text = chunk({ content: 'partial' });
  const result: Frame[] = [];
  for await (const frame of ordered(frames(text))) result.push(frame);
  expect(result).toEqual([text]);
});

test('keeps mixed-frame usage exactly once with content and retains opaque reasoning', async () => {
  const mixed: OpenAIChatCompletionsStreamEvent = {
    id: 'chat_order',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{
      index: 0,
      delta: { reasoning_content: 'thought', reasoning_opaque: 'opaque', content: 'answer' },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  };
  const result: Frame[] = [];
  for await (const frame of ordered(frames(eventFrame(mixed), doneFrame()))) result.push(frame);

  expect(result).toEqual([
    eventFrame({
      ...mixed,
      usage: undefined,
      choices: [{ index: 0, delta: { reasoning_content: 'thought', reasoning_opaque: 'opaque' }, finish_reason: null }],
    }),
    eventFrame({ ...mixed, choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }] }),
    doneFrame(),
  ]);
});

test('preserves non-event failures by identity', () => {
  const failure = {
    type: 'api-error' as const,
    source: 'upstream' as const,
    status: 502,
    headers: new Headers(),
    body: new Uint8Array([1, 2]),
  };
  expect(withOpenAIChatCompletionsReasoningBeforeContent(failure)).toBe(failure);
});
