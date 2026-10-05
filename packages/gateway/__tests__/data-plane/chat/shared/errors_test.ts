import { test } from 'vitest';

import { anthropicUsageLimitErrorResult } from '../../../../src/data-plane/chat/anthropic-messages/errors.ts';
import { geminiUsageLimitErrorResult } from '../../../../src/data-plane/chat/gemini-generate-content/errors.ts';
import { type ChatServeFailure, openAiUsageLimitErrorResult, throwChatServeFailure, tryCatchChatServeFailure } from '../../../../src/data-plane/chat/shared/errors.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const cases: readonly ChatServeFailure[] = [
  { kind: 'model-missing', model: 'gpt-9', failedUpstreams: [] },
  { kind: 'model-missing', model: 'gpt-9', failedUpstreams: ['Azure prod'] },
  { kind: 'model-unsupported', model: 'gpt-9', failedUpstreams: [] },
  { kind: 'model-unsupported', model: 'gpt-9', failedUpstreams: ['Azure prod', 'Custom'] },
  { kind: 'routing-unavailable', message: 'no upstream can serve this' },
];

for (const failure of cases) {
  const label = 'failedUpstreams' in failure && failure.failedUpstreams.length
    ? `${failure.kind} (with ${failure.failedUpstreams.length} failed upstream(s))`
    : failure.kind;
  test(`round-trips ${label} through throw/catch`, () => {
    const error = assertThrows(() => throwChatServeFailure(failure));
    assertEquals(tryCatchChatServeFailure(error), failure);
  });
}

test('returns null for an error not raised by throwChatServeFailure', () => {
  assertEquals(tryCatchChatServeFailure(new Error('something else')), null);
  assertEquals(tryCatchChatServeFailure('not even an error'), null);
  assertEquals(tryCatchChatServeFailure(null), null);
});

test('usage denials render protocol-specific resource-exhausted errors', () => {
  const denial = { ok: false, reason: 'tokens' } as const;
  const openAi = openAiUsageLimitErrorResult(denial);
  const anthropic = anthropicUsageLimitErrorResult(denial);
  const gemini = geminiUsageLimitErrorResult(denial);
  if (anthropic.type !== 'api-error' || gemini.type !== 'api-error') throw new Error('Usage denials must be API errors');

  assertEquals(openAi.status, 429);
  assertEquals(JSON.parse(new TextDecoder().decode(openAi.body)), {
    error: {
      message: 'Usage limit exceeded for this API key or user.',
      type: 'rate_limit_error',
      param: 'usage',
      code: 'usage_limit_exceeded',
    },
  });
  assertEquals(anthropic.status, 429);
  assertEquals(JSON.parse(new TextDecoder().decode(anthropic.body)).error.type, 'rate_limit_error');
  assertEquals(gemini.status, 429);
  assertEquals(JSON.parse(new TextDecoder().decode(gemini.body)).error.status, 'RESOURCE_EXHAUSTED');
});

test('usage-ledger storage failures render unavailable protocol errors', () => {
  const denial = { ok: false, reason: 'storage', error: new Error('db down') } as const;
  const openAi = openAiUsageLimitErrorResult(denial);
  const anthropic = anthropicUsageLimitErrorResult(denial);
  const gemini = geminiUsageLimitErrorResult(denial);
  if (anthropic.type !== 'api-error' || gemini.type !== 'api-error') throw new Error('Storage failures must be API errors');

  assertEquals(openAi.status, 503);
  assertEquals(JSON.parse(new TextDecoder().decode(openAi.body)).error.code, 'usage_limit_storage_unavailable');
  assertEquals(anthropic.status, 503);
  assertEquals(JSON.parse(new TextDecoder().decode(anthropic.body)).error.type, 'overloaded_error');
  assertEquals(gemini.status, 503);
  assertEquals(JSON.parse(new TextDecoder().decode(gemini.body)).error.status, 'UNAVAILABLE');
});
