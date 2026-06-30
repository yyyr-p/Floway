import { describe, expect, test, vi } from 'vitest';

import { AgentTransport } from './agent-transport.ts';
import { addConnectEnvelope, encodeMessageField, encodeStringField } from './proto/index.ts';
import type { AgentChatRequest, RequestContextEnv } from './proto/index.ts';

const ENV: RequestContextEnv = { workspacePath: '/tmp', osVersion: 'darwin 24.0.0', shell: '/bin/zsh', timezone: 'UTC' };

function makeTransport(fetchMock: unknown): AgentTransport {
  return new AgentTransport({
    accessToken: 'tok',
    baseUrl: 'https://api2.cursor.sh',
    env: ENV,
    clientVersion: 'cli-test',
    getChecksum: () => 'checksum-value',
    fetch: fetchMock as typeof fetch,
    maxRetries: 1,
    requestTimeoutMs: 5000,
  });
}

function okEmptyResponse(): Response {
  return new Response(new Uint8Array(0), { status: 200 });
}

// AgentServerMessage { field 1: InteractionUpdate { field 1: TextDeltaUpdate { field 1: text } } }
function textFrame(text: string): Uint8Array {
  const interactionUpdate = encodeMessageField(1, encodeStringField(1, text));
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

function turnEndedFrame(): Uint8Array {
  // InteractionUpdate.field 14 (turn_ended), wire type 0, value 0 — presence matters
  const interactionUpdate = new Uint8Array([(14 << 3) | 0, 0]);
  const serverMsg = encodeMessageField(1, interactionUpdate);
  return addConnectEnvelope(serverMsg);
}

function heartbeatFrame(): Uint8Array {
  // InteractionUpdate.field 13 (heartbeat), wire type 0, value 0
  const interactionUpdate = new Uint8Array([(13 << 3) | 0, 0]);
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

async function collect(gen: AsyncGenerator): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

const BIDI_URL = 'https://api2.cursor.sh/aiserver.v1.BidiService/BidiAppend';

describe('AgentTransport.bidiAppend', () => {
  test('POSTs the envelope on the write channel', async () => {
    const fetchMock = vi.fn(async () => okEmptyResponse());
    const transport = makeTransport(fetchMock);
    await transport.bidiAppend('req-1', 0n, new Uint8Array([1, 2, 3]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(url).toBe(BIDI_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer tok');
    expect(headers['x-cursor-checksum']).toBe('checksum-value');
    expect(headers['content-type']).toBe('application/grpc-web+proto');
  });

  test('retries on transient network errors', async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) throw new Error('ECONNRESET socket closed');
      return okEmptyResponse();
    });
    const transport = makeTransport(fetchMock);
    await transport.bidiAppend('req-1', 0n, new Uint8Array([1]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('does not retry on non-network errors', async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) throw new Error('invalid argument');
      return okEmptyResponse();
    });
    const transport = makeTransport(fetchMock);
    await expect(transport.bidiAppend('req-1', 0n, new Uint8Array([1]))).rejects.toThrow('invalid argument');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('surfaces non-ok status as an error', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 }));
    const transport = makeTransport(fetchMock);
    await expect(transport.bidiAppend('req-1', 0n, new Uint8Array([1]))).rejects.toThrow('BidiAppend failed: 401');
  });
});

describe('AgentTransport.openChatStream', () => {
  function dualChannelMock(runSseResponse: Response): ReturnType<typeof vi.fn> {
    return vi.fn(async (url: string) => {
      if (String(url).includes('RunSSE')) return runSseResponse;
      return okEmptyResponse(); // BidiAppend
    });
  }

  test('yields text then done on a clean turn', async () => {
    const fetchMock = dualChannelMock(streamResponse(textFrame('hello'), turnEndedFrame()));
    const transport = makeTransport(fetchMock);

    const chunks = await collect(transport.openChatStream({ message: 'hi', model: 'gpt-4o' } as AgentChatRequest));

    const types = chunks.map(c => (c as { type: string }).type);
    expect(types).toContain('text');
    expect((chunks.find(c => (c as { type: string }).type === 'text') as { content?: string })?.content).toBe('hello');
    expect(types[types.length - 1]).toBe('done');
  });

  test('heartbeats after text do not preempt turn_ended (authoritative end)', async () => {
    // Regression: a raw heartbeat count must NOT end the turn after output has
    // started — cursor interleaves keep-alive heartbeats and KV checkpoints
    // between the final text and the turn_ended (IU field 14) marker. Closing
    // on a beat count truncated short answers whose turn_ended lagged behind.
    const fetchMock = dualChannelMock(streamResponse(
      textFrame('the answer is 42'),
      heartbeatFrame(), heartbeatFrame(), heartbeatFrame(),
      heartbeatFrame(), heartbeatFrame(), heartbeatFrame(),
      turnEndedFrame(),
    ));
    const transport = makeTransport(fetchMock);

    const chunks = await collect(transport.openChatStream({ message: 'hi', model: 'gpt-4o' } as AgentChatRequest));
    const types = chunks.map(c => (c as { type: string }).type);

    // The full text survives, and the turn ends on the turn_ended frame (done
    // is the last chunk), not cut short by the six intervening heartbeats.
    expect((chunks.find(c => (c as { type: string }).type === 'text') as { content?: string })?.content).toBe('the answer is 42');
    expect(types[types.length - 1]).toBe('done');
  });

  test('sends the initial RunRequest on BidiAppend concurrently with RunSSE', async () => {
    const fetchMock = dualChannelMock(streamResponse(textFrame('hi'), turnEndedFrame()));
    const transport = makeTransport(fetchMock);
    await collect(transport.openChatStream({ message: 'hi', model: 'gpt-4o' } as AgentChatRequest));

    const bidiCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('BidiAppend'));
    const runSseCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('RunSSE'));
    expect(runSseCalls).toHaveLength(1);
    // At least the initial RunRequest BidiAppend
    expect(bidiCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('yields an error chunk on non-ok RunSSE', async () => {
    const fetchMock = dualChannelMock(new Response('upstream down', { status: 503 }));
    const transport = makeTransport(fetchMock);
    const chunks = await collect(transport.openChatStream({ message: 'hi', model: 'gpt-4o' } as AgentChatRequest));
    const err = chunks.find(c => (c as { type: string }).type === 'error') as { error?: string };
    expect(err).toBeDefined();
    expect(err!.error).toContain('503');
  });

  test('yields an error chunk when RunSSE has no body', async () => {
    const fetchMock = dualChannelMock(new Response(null, { status: 200 }));
    const transport = makeTransport(fetchMock);
    const chunks = await collect(transport.openChatStream({ message: 'hi', model: 'gpt-4o' } as AgentChatRequest));
    const err = chunks.find(c => (c as { type: string }).type === 'error') as { error?: string };
    expect(err?.error).toContain('No response body');
  });
});

describe('AgentTransport.sendRejectedTool', () => {
  test('sends a result frame then a stream-close control (2 BidiAppends)', async () => {
    // Open a stream first so currentRequestId is set (sendExecAndClose guards it).
    const runSseFetch = vi.fn(async (url: string) => {
      if (String(url).includes('RunSSE')) return streamResponse(textFrame('hi'), turnEndedFrame());
      return okEmptyResponse();
    });
    const transport2 = makeTransport(runSseFetch);
    // Drive the stream just enough to set currentRequestId, then reject a shell tool.
    const gen = transport2.openChatStream({ message: 'hi', model: 'gpt-4o' } as AgentChatRequest);
    await gen.next(); // text chunk, currentRequestId now set

    const bidiBefore = runSseFetch.mock.calls.filter(c => String(c[0]).includes('BidiAppend')).length;
    await transport2.sendRejectedTool({ type: 'shell', id: 9, execId: 'e1', command: 'rm', cwd: '/' }, 'no shell in gateway');
    const bidiAfter = runSseFetch.mock.calls.filter(c => String(c[0]).includes('BidiAppend')).length;
    expect(bidiAfter - bidiBefore).toBe(2); // exec result + control close
    await gen.return(undefined);
  });

  test('throws when no active stream is open', async () => {
    const transport = makeTransport(vi.fn(async () => okEmptyResponse()));
    await expect(
      transport.sendRejectedTool({ type: 'shell', id: 1, command: 'x', cwd: '/' }, 'reason'),
    ).rejects.toThrow('No active chat stream');
  });
});
