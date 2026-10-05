import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  createSoftConcurrencyQueueMiddleware,
  parseSoftConcurrencyQueueConfig,
  type SoftConcurrencyQueueConfig,
} from '../../src/middleware/soft-concurrency-queue.ts';

const config = (overrides: Partial<SoftConcurrencyQueueConfig> = {}): SoftConcurrencyQueueConfig => ({
  limit: 1,
  maxQueueSize: 10,
  maxWaitMs: 1_000,
  ...overrides,
});

const heldResponse = (onCancel?: () => void): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('open'));
  },
  cancel() {
    onCancel?.();
  },
}));

const appWithQueue = (
  settings: SoftConcurrencyQueueConfig,
  respond: (path: string, id: string | null) => Response = () => heldResponse(),
) => {
  const entered: string[] = [];
  const app = new Hono();
  app.onError((error, c) => c.json({ message: error instanceof Error ? error.message : String(error) }, 500));
  app.use('*', createSoftConcurrencyQueueMiddleware(() => settings));
  app.all('*', c => {
    const id = c.req.query('request');
    entered.push(id ?? c.req.path);
    return respond(c.req.path, id ?? null);
  });
  return { app, entered };
};

const request = (
  app: Hono,
  id?: string,
  init: RequestInit = {},
): Promise<Response> => Promise.resolve(app.request(`/v1/chat/completions${id ? `?request=${id}` : ''}`, {
  method: 'POST',
  ...init,
}));

afterEach(() => vi.useRealTimers());

describe('soft concurrency queue', () => {
  test('parses defaults, disabled limits, zero queue capacity, and positive bounds', () => {
    expect(parseSoftConcurrencyQueueConfig({ limit: '', maxQueueSize: '', maxWaitMs: '' })).toEqual({
      limit: null,
      maxQueueSize: 100,
      maxWaitMs: 30_000,
    });
    expect(parseSoftConcurrencyQueueConfig({ limit: '', maxQueueSize: '100', maxWaitMs: '30000' })).toEqual({
      limit: null,
      maxQueueSize: 100,
      maxWaitMs: 30_000,
    });
    expect(parseSoftConcurrencyQueueConfig({ limit: '0', maxQueueSize: '0', maxWaitMs: '1' })).toEqual({
      limit: null,
      maxQueueSize: 0,
      maxWaitMs: 1,
    });
    expect(parseSoftConcurrencyQueueConfig({ limit: ' 2 ', maxQueueSize: '10', maxWaitMs: '250' })).toEqual({
      limit: 2,
      maxQueueSize: 10,
      maxWaitMs: 250,
    });
  });

  test.each([
    ['limit', { limit: '-1', maxQueueSize: '1', maxWaitMs: '10' }, /FLOWAY_SOFT_CONCURRENT_REQUESTS/],
    ['queue size', { limit: '1', maxQueueSize: '10001', maxWaitMs: '10' }, /FLOWAY_CONCURRENCY_QUEUE_MAX_SIZE/],
    ['wait', { limit: '1', maxQueueSize: '1', maxWaitMs: '0' }, /FLOWAY_CONCURRENCY_QUEUE_MAX_WAIT_MS/],
    ['wait timer bound', { limit: '1', maxQueueSize: '1', maxWaitMs: '2147483648' }, /FLOWAY_CONCURRENCY_QUEUE_MAX_WAIT_MS/],
  ])('rejects invalid %s values instead of silently disabling backpressure', (_label, values, message) => {
    expect(() => parseSoftConcurrencyQueueConfig(values)).toThrow(message);
  });

  test('admits waiters FIFO and enters handlers only after an active response releases', async () => {
    const { app, entered } = appWithQueue(config(), (_path, id) => new Response(id));
    const first = await request(app, 'first');
    const secondPending = request(app, 'second');
    const thirdPending = request(app, 'third');

    expect(entered).toEqual(['first']);
    await first.body?.cancel();

    const second = await secondPending;
    expect(entered).toEqual(['first', 'second']);
    expect(second.headers.get('x-floway-queue-status')).toBe('admitted');
    expect(second.headers.get('x-floway-queue-position')).toBe('1');
    expect(Number(second.headers.get('x-floway-queue-wait-ms'))).toBeGreaterThanOrEqual(0);
    expect(await second.text()).toBe('second');

    const third = await thirdPending;
    expect(entered).toEqual(['first', 'second', 'third']);
    expect(third.headers.get('x-floway-queue-position')).toBe('2');
    expect(await third.text()).toBe('third');
  });

  test('bounds the queue and returns a retryable protocol error when it is full', async () => {
    const { app, entered } = appWithQueue(config({ maxQueueSize: 1 }));
    const active = await request(app, 'active');
    const waiting = request(app, 'waiting');
    const full = await request(app, 'overflow');

    expect(entered).toEqual(['active']);
    expect(full.status).toBe(429);
    expect(full.headers.get('retry-after')).toBe('1');
    expect(full.headers.get('cache-control')).toBe('no-store');
    expect(full.headers.get('x-floway-queue-status')).toBe('full');
    expect(full.headers.get('x-floway-queue-depth')).toBe('1');
    expect(await full.json()).toMatchObject({
      error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    });

    await active.body?.cancel();
    const admitted = await waiting;
    expect(admitted.headers.get('x-floway-queue-status')).toBe('admitted');
    await admitted.body?.cancel();
  });

  test.each([
    ['/v1/messages', 'POST', 'anthropic'],
    ['/v1beta/models/gemini-2.5-pro:generateContent', 'POST', 'gemini'],
  ] as const)('uses the %s protocol error envelope when no queue capacity remains', async (path, method, protocol) => {
    const app = new Hono();
    app.use('*', createSoftConcurrencyQueueMiddleware(() => config({ maxQueueSize: 0 })));
    app.all('*', () => heldResponse());
    const active = await app.request(path, { method });
    const rejected = await app.request(path, { method });

    expect(rejected.status).toBe(429);
    if (protocol === 'anthropic') {
      const body = await rejected.json() as { request_id?: string; error?: { type?: string } };
      expect(body.error?.type).toBe('rate_limit_error');
      expect(body.request_id).toMatch(/^req_/);
    } else {
      expect(await rejected.json()).toMatchObject({
        error: { code: 429, status: 'RESOURCE_EXHAUSTED' },
      });
    }
    await active.body?.cancel();
  });

  test('returns a retryable timeout response and removes the expired waiter', async () => {
    vi.useFakeTimers();
    const { app, entered } = appWithQueue(config({ maxWaitMs: 25 }));
    const active = await request(app, 'active');
    const waiting = request(app, 'waiting');

    await vi.advanceTimersByTimeAsync(25);
    const timedOut = await waiting;
    expect(entered).toEqual(['active']);
    expect(timedOut.status).toBe(429);
    expect(timedOut.headers.get('x-floway-queue-status')).toBe('timeout');
    expect(timedOut.headers.get('x-floway-queue-position')).toBe('1');
    expect(timedOut.headers.get('x-floway-queue-wait-ms')).not.toBeNull();
    expect(await timedOut.json()).toMatchObject({
      error: { message: expect.stringContaining('Timed out waiting for a concurrency slot.') },
    });

    const replacement = request(app, 'replacement');
    await active.body?.cancel();
    const admitted = await replacement;
    expect(entered).toEqual(['active', 'replacement']);
    await admitted.body?.cancel();
  });

  test('removes an aborted waiter without consuming a queue position or active slot', async () => {
    const { app, entered } = appWithQueue(config({ maxQueueSize: 1 }));
    const active = await request(app, 'active');
    const controller = new AbortController();
    const abortedRequest = request(app, 'aborted', { signal: controller.signal });
    const reason = new DOMException('client disconnected', 'AbortError');
    controller.abort(reason);

    const aborted = await abortedRequest;
    expect(aborted.status).toBe(500);
    expect(await aborted.json()).toEqual({ message: reason.message });

    const replacement = request(app, 'replacement');
    expect(entered).toEqual(['active']);
    await active.body?.cancel();
    const admitted = await replacement;
    expect(entered).toEqual(['active', 'replacement']);
    expect(admitted.headers.get('x-floway-queue-position')).toBe('1');
    await admitted.body?.cancel();
  });

  test('client abort after admission cancels the stream and releases the slot', async () => {
    let markCancelled: (() => void) | undefined;
    const cancelled = new Promise<void>(resolve => { markCancelled = resolve; });
    const { app, entered } = appWithQueue(config(), () => heldResponse(() => markCancelled?.()));
    const controller = new AbortController();
    await request(app, 'active', { signal: controller.signal });
    controller.abort(new DOMException('client disconnected', 'AbortError'));
    await cancelled;

    const next = await request(app, 'next');
    expect(entered).toEqual(['active', 'next']);
    await next.body?.cancel();
  });

  test('keeps the slot until upstream cancellation settles', async () => {
    let finishCancellation: (() => void) | undefined;
    let markCancellationStarted: (() => void) | undefined;
    const cancellationStarted = new Promise<void>(resolve => { markCancellationStarted = resolve; });
    const { app, entered } = appWithQueue(config(), (_path, id) => id === 'active'
      ? new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('open'));
          },
          cancel() {
            markCancellationStarted?.();
            return new Promise<void>(resolve => { finishCancellation = resolve; });
          },
        }))
      : new Response('complete'));
    const controller = new AbortController();
    await request(app, 'active', { signal: controller.signal });
    const waiting = request(app, 'waiting');

    controller.abort(new DOMException('client disconnected', 'AbortError'));
    await cancellationStarted;
    expect(entered).toEqual(['active']);

    finishCancellation?.();
    const admitted = await waiting;
    expect(entered).toEqual(['active', 'waiting']);
    await admitted.body?.cancel();
  });

  test('holds the slot through stream completion, and releases it on body errors or handler errors', async () => {
    let failNextStream = true;
    let failNextHandler = false;
    const originalStreamError = new Error('stream read failed');
    const originalHandlerError = new Error('handler dispatch failed');
    const { app } = appWithQueue(config(), () => {
      if (failNextHandler) {
        failNextHandler = false;
        throw originalHandlerError;
      }
      if (failNextStream) {
        failNextStream = false;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(originalStreamError);
          },
        }));
      }
      return new Response('complete');
    });

    const brokenStream = await request(app);
    await expect(brokenStream.text()).rejects.toBe(originalStreamError);
    const completed = await request(app);
    expect(await completed.text()).toBe('complete');

    failNextHandler = true;
    const failedHandler = await request(app);
    expect(failedHandler.status).toBe(500);
    expect(await failedHandler.json()).toEqual({ message: originalHandlerError.message });
    const afterFailure = await request(app);
    expect(await afterFailure.text()).toBe('complete');
  });

  test('bypasses control-plane paths and WebSocket upgrades', async () => {
    let calls = 0;
    const app = new Hono();
    app.use('*', createSoftConcurrencyQueueMiddleware(() => config()));
    app.all('*', () => {
      calls += 1;
      return heldResponse();
    });

    const active = await request(app, 'active');
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/v1/responses', { method: 'GET', headers: { upgrade: 'websocket' } })).status).toBe(200);
    expect(calls).toBe(3);
    await active.body?.cancel();
  });

  test('keeps separate queue state for separate gateway app instances', async () => {
    const first = appWithQueue(config());
    const second = appWithQueue(config());
    const firstActive = await request(first.app, 'active');
    const secondActive = await request(second.app, 'active');

    expect(first.entered).toEqual(['active']);
    expect(second.entered).toEqual(['active']);
    await firstActive.body?.cancel();
    await secondActive.body?.cancel();
  });
});
