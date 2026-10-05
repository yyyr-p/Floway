import { expect, test } from 'vitest';

import { analyzeAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/ingress.ts';
import { analyzeOpenAIChatCompletionsAffinity } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/ingress.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { AffinityCodec, compatibilityIdentityForCandidate, defineAffinityRequest, selectAffinityCandidates } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));
const candidate = (id: string): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({ provider: { ...base.provider, upstreamId: id }, model: { id: 'model' } });
};
const target = (value: ModelCandidate) => ({
  upstreamId: value.provider.upstreamId, modelId: value.model.id,
  opaqueBlobCompatibilityIdentity: compatibilityIdentityForCandidate(value),
});
const a = candidate('up-a');
const b = candidate('up-b');

for (const natural of [false, true]) {
  test(`latest Chat carrier wins over old natural history, natural=${natural}`, async () => {
    const old = await codec.wrap('opaque-a', target(a), 'openai-chat-completions.reasoning_opaque');
    const latest = await codec.wrap(natural ? 'opaque-b' : undefined, target(b), 'openai-chat-completions.reasoning_opaque');
    const analysis = await analyzeOpenAIChatCompletionsAffinity({
      model: 'alias', messages: [
        { role: 'assistant', content: 'answer', reasoning_opaque: old }, { role: 'assistant', content: 'answer', reasoning_opaque: latest },
      ],
    }, codec);
    const selection = selectAffinityCandidates([a, b], analysis);
    expect(selection).not.toHaveProperty('kind');
    if ('kind' in selection) throw new Error(selection.message);
    expect(selection.candidates).toEqual([b, a]);
  });

  test(`latest Messages carrier wins over old natural history, natural=${natural}`, async () => {
    const old = await codec.wrap('opaque-a', target(a), 'anthropic-messages.thinking.signature');
    const latest = await codec.wrap(natural ? 'opaque-b' : undefined, target(b), 'anthropic-messages.redacted_thinking.data');
    const analysis = await analyzeAnthropicMessagesAffinity({
      model: 'alias', max_tokens: 100, messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'old', signature: old }] },
        { role: 'assistant', content: [{ type: 'redacted_thinking', data: latest }] },
      ],
    }, codec);
    const selection = selectAffinityCandidates([a, b], analysis);
    if ('kind' in selection) throw new Error(selection.message);
    expect(selection.candidates).toEqual([b, a]);
  });

  test(`latest Responses carrier wins over old natural history, natural=${natural}`, async () => {
    const domain = 'openai-responses.reasoning.encrypted_content';
    const old = await codec.wrap('opaque-a', target(a), domain);
    const latest = await codec.wrap(natural ? 'opaque-b' : undefined, target(b), domain, natural ? undefined : { syntheticItem: true });
    const analysis = await analyzeOpenAIResponsesAffinity({
      model: 'alias', input: [
        { type: 'reasoning', id: 'rs_old', summary: [], encrypted_content: old },
        { type: 'reasoning', id: 'rs_latest', summary: [], encrypted_content: latest },
      ],
    }, codec);
    const selection = selectAffinityCandidates([a, b], analysis);
    if ('kind' in selection) throw new Error(selection.message);
    expect(selection.candidates).toEqual([b, a]);
  });
}

for (const preserveOpaque of [false, true]) {
  test(`alias fallback respects the configured opaque policy: ${preserveOpaque}`, () => {
    const aliasCandidate = (value: ModelCandidate, group: number) => ({ ...value, rules: {}, aliasRouting: { id: 'alias', group, preserveOpaque } });
    const first = aliasCandidate(a, 0);
    const last = aliasCandidate(b, 1);
    const compatible = aliasCandidate(candidate('up-c'), 2);
    const analysis = defineAffinityRequest([], value => ({ kind: 'accepted', degrades: value === first, materialize: () => undefined }), target(b));
    const selection = selectAffinityCandidates([first, last, compatible], analysis);
    if ('kind' in selection) throw new Error(selection.message);
    expect(selection.candidates).toEqual(preserveOpaque ? [last, compatible, first] : [last, first, compatible]);
  });
}

test('latest route cannot bypass a required opaque compatibility constraint', () => {
  const analysis = defineAffinityRequest([target(a)], value => value === a
    ? { kind: 'accepted', degrades: false, materialize: () => undefined } : { kind: 'rejected' }, target(b));
  const selection = selectAffinityCandidates([a, b], analysis);
  if ('kind' in selection) throw new Error(selection.message);
  expect(selection.candidates).toEqual([a]);
});
