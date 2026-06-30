import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { callCursorChatCompletions, type CursorCallEffects } from './fetch.ts';
import { addConnectEnvelope, encodeMessageField, encodeStringField } from './proto/index.ts';
import type { CursorAccessTokenEntry, CursorAccountCredential, CursorUpstreamState } from './state.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { initProviderRepo, type UpstreamModel, type UpstreamRecord } from '@floway-dev/provider';
import { noopUpstreamCallOptions, stubUpstreamModel } from '@floway-dev/test-utils';

const makeEffects = (): CursorCallEffects => ({
  persistRefreshTokenRotation: vi.fn(async () => {}),
  persistTerminalState: vi.fn(async () => {}),
});

const farFutureAccessToken: CursorAccessTokenEntry = {
  token: 'at.cursor.test',
  expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  refreshedAt: '2026-01-01T00:00:00Z',
};

const activeAccount: CursorAccountCredential = {
  userId: 'u1',
  refresh_token: 'rt_v1',
  state: 'active',
  state_updated_at: '2026-01-01T00:00:00Z',
  accessToken: farFutureAccessToken,
  quotaSnapshot: null,
};

const model: UpstreamModel = stubUpstreamModel({ id: 'gpt-4o', display_name: 'gpt-4o', endpoints: { chatCompletions: {} } });
const upstreamId = 'up_a';

const makeRecord = (state: CursorUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  provider: 'cursor',
  name: 'Cursor',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  config: { accounts: [{ email: 'a@b.com', userId: 'u1' }] },
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
});

let currentRecord: UpstreamRecord;

beforeEach(() => {
  vi.useRealTimers();
  currentRecord = makeRecord({ accounts: [{ ...activeAccount }] });
  initProviderRepo(() => ({
    upstreams: {
      getById: async () => currentRecord,
      saveState: async (_id, newState) => {
        currentRecord = { ...currentRecord, state: newState as CursorUpstreamState };
        return { updated: true };
      },
    },
  }));
});

afterEach(() => vi.restoreAllMocks());

// AgentServerMessage { field 1: InteractionUpdate { field 1: TextDeltaUpdate { field 1: text } } }
function textFrame(text: string): Uint8Array {
  const interactionUpdate = encodeMessageField(1, encodeStringField(1, text));
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

function turnEndedFrame(): Uint8Array {
  const interactionUpdate = new Uint8Array([(14 << 3) | 0, 0]);
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

function streamResponse(...frames: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(f);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/grpc-web+proto' } });
}

const mockCursorFetch = (runSse: Response): ReturnType<typeof vi.spyOn> =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(typeof input === 'string' ? input : (input as URL).toString());
    if (url.includes('RunSSE')) return runSse;
    if (url.includes('BidiAppend')) return new Response(new Uint8Array(0), { status: 200 });
    return new Response('', { status: 404 });
  });

const collectEvents = async (result: { ok: true; events: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>> }): Promise<ChatCompletionsStreamEvent[]> => {
  const events: ChatCompletionsStreamEvent[] = [];
  for await (const frame of result.events) {
    if (frame.type === 'event') events.push(frame.event);
    else break;
  }
  return events;
};

describe('callCursorChatCompletions', () => {
  test('refuses non-active state with synthetic 503', async () => {
    const result = await callCursorChatCompletions({
      upstreamId,
      account: { ...activeAccount, state: 'session_terminated' },
      model,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(503);
      expect(await result.response.text()).toMatch(/session_terminated/);
    }
  });

  test('streams text + finish_reason=stop on a clean turn', async () => {
    mockCursorFetch(streamResponse(textFrame('hello'), turnEndedFrame()));
    const result = await callCursorChatCompletions({
      upstreamId,
      account: activeAccount,
      model,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const events = await collectEvents(result);
    const contents = events.map(e => e.choices[0]?.delta?.content ?? '').filter(c => c !== '');
    expect(contents).toContain('hello');
    const last = events[events.length - 1]!;
    expect(last.choices[0]?.finish_reason).toBe('stop');
  });

  test('surfaces a non-ok RunSSE as a thrown stream error', async () => {
    mockCursorFetch(new Response('upstream down', { status: 503 }));
    const result = await callCursorChatCompletions({
      upstreamId,
      account: activeAccount,
      model,
      body: { messages: [{ role: 'user', content: 'hi' }] },
      headers: new Headers(),
      effects: makeEffects(),
      call: noopUpstreamCallOptions(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(collectEvents(result)).rejects.toThrow(/SSE stream failed: 503/);
  });
});
