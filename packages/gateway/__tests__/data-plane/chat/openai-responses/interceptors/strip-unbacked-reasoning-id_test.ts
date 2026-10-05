import { test } from 'vitest';

import { withOpenAIResponsesReasoningIdStripped } from '../../../../../src/data-plane/chat/openai-responses/interceptors/strip-unbacked-reasoning-id.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () { yield doneFrame(); })(), testTelemetryModelIdentity));

const strip = async (
  input: OpenAIResponsesInputItem[],
  { targetApi = 'openaiResponses' }: { targetApi?: OpenAIResponsesInvocation['targetApi'] } = {},
): Promise<{ before: OpenAIResponsesInvocation['payload']; seen: OpenAIResponsesInvocation['payload'] }> => {
  const invocation: OpenAIResponsesInvocation = {
    payload: { model: 'test-model', input },
    candidate: stubModelCandidate({ enabledFlags: new Set<FlagId>() }),
    targetApi,
    headers: new Headers(),
    action: 'generate',
  };
  const before = invocation.payload;
  let seen: OpenAIResponsesInvocation['payload'] | undefined;
  await withOpenAIResponsesReasoningIdStripped(invocation, gatewayCtx, () => {
    seen = invocation.payload;
    return okEvents();
  });
  return { before, seen: seen! };
};

test('strips ids from blob-less reasoning items on an OpenAI Responses target', async () => {
  const unbacked = {
    type: 'reasoning' as const,
    id: 'rs_542e678b3a6a71ba5ff94079e81fa6e1',
    summary: [{ type: 'summary_text' as const, text: 'We need continue. Need inspect agents status.' }],
  };
  const context: OpenAIResponsesInputItem = { type: 'message', role: 'user', content: 'next turn' };

  const { before, seen } = await strip([unbacked, context]);
  assertEquals(seen.input, [
    {
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'We need continue. Need inspect agents status.' }],
    },
    context,
  ]);
  assertEquals(before.input[0], unbacked);
});

test('keeps the id on a reasoning item whose encrypted_content follows it', async () => {
  const carried = {
    type: 'reasoning' as const,
    id: 'rs_signed',
    summary: [{ type: 'summary_text' as const, text: 'trace' }],
    encrypted_content: 'upstream-signed-blob',
  };

  const { seen } = await strip([carried]);
  assertEquals(seen.input[0], carried);
});

test('leaves the payload untouched on translated targets and when no id is present', async () => {
  const context: OpenAIResponsesInputItem = { type: 'message', role: 'user', content: 'next turn' };
  const idLess = {
    type: 'reasoning' as const,
    summary: [{ type: 'summary_text' as const, text: 'synthesized trace' }],
  };

  for (const targetApi of ['anthropicMessages', 'openaiChatCompletions'] as const) {
    const { before, seen } = await strip([context], { targetApi });
    assertEquals(seen, before);
  }
  const { before, seen } = await strip([idLess, context]);
  assertEquals(seen, before);
  assertEquals(seen.input[0], idLess);
});
