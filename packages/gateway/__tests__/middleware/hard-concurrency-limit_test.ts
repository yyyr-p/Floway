import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';

import { createHardConcurrencyLimitMiddleware, parseHardConcurrentRequestLimit } from '../../src/middleware/hard-concurrency-limit.ts';

const heldResponse = (): Response => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('open'));
  },
}));

const appWithLimit = (
  limit: number,
  respond: (path: string) => Response = () => new Response('ok'),
) => {
  const app = new Hono();
  app.onError((error, c) => c.json({ message: error.message }, 500));
  app.use('*', createHardConcurrencyLimitMiddleware(() => limit));
  app.all('*', c => respond(c.req.path));
  return app;
};

const openRequest = (app: Hono, path = '/v1/chat/completions', method = 'POST'): Promise<Response> =>
  Promise.resolve(app.request(path, { method }));

describe('hard concurrency limit', () => {
  test('parses an unset, disabled, or positive safe integer setting', () => {
    expect(parseHardConcurrentRequestLimit('')).toBeNull();
    expect(parseHardConcurrentRequestLimit('0')).toBeNull();
    expect(parseHardConcurrentRequestLimit(' 12 ')).toBe(12);
    expect(() => parseHardConcurrentRequestLimit('-1')).toThrow(/FLOWAY_MAX_CONCURRENT_REQUESTS/);
    expect(() => parseHardConcurrentRequestLimit('1.5')).toThrow(/FLOWAY_MAX_CONCURRENT_REQUESTS/);
    expect(() => parseHardConcurrentRequestLimit(String(Number.MAX_SAFE_INTEGER + 1))).toThrow(/FLOWAY_MAX_CONCURRENT_REQUESTS/);
  });

  test('returns an OpenAI rate limit error with Retry-After before admitting an excess request', async () => {
    let calls = 0;
    const app = appWithLimit(1, () => {
      calls += 1;
      return heldResponse();
    });

    const admitted = await openRequest(app);
    const rejected = await openRequest(app);

    expect(calls).toBe(1);
    expect(rejected.status).toBe(429);
    expect(rejected.headers.get('retry-after')).toBe('1');
    expect(rejected.headers.get('cache-control')).toBe('no-store');
    expect(await rejected.json()).toEqual({
      error: {
        message: 'Too many concurrent requests. Retry the request shortly.',
        type: 'rate_limit_error',
        param: null,
        code: 'rate_limit_exceeded',
      },
    });
    await admitted.body?.cancel();
  });

  test.each([
    ['/v1/messages', {
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Too many concurrent requests. Retry the request shortly.' },
    }],
    ['/v1beta/models/gemini-2.5-pro:generateContent', {
      error: {
        code: 429,
        message: 'Too many concurrent requests. Retry the request shortly.',
        status: 'RESOURCE_EXHAUSTED',
      },
    }],
  ])('uses the %s API error envelope for synthetic 429 responses', async (path, expectedBody) => {
    const app = appWithLimit(1, () => heldResponse());
    const admitted = await openRequest(app);
    const rejected = await openRequest(app, path);

    expect(rejected.status).toBe(429);
    const body = await rejected.json() as { request_id?: string };
    expect(body).toMatchObject(expectedBody);
    if (path === '/v1/messages') {
      expect(body.request_id).toMatch(/^req_/);
    }
    await admitted.body?.cancel();
  });

  test('holds separate slots for simultaneous streams until each stream is cancelled', async () => {
    const app = appWithLimit(2, () => heldResponse());
    const first = await openRequest(app);
    const second = await openRequest(app);

    expect((await openRequest(app)).status).toBe(429);

    await first.body?.cancel('client disconnected');
    const replacement = await openRequest(app);
    expect(replacement.status).toBe(200);
    await replacement.body?.cancel();

    const another = await openRequest(app);
    expect(another.status).toBe(200);
    expect((await openRequest(app)).status).toBe(429);
    await second.body?.cancel();
    await another.body?.cancel();
    const final = await openRequest(app);
    expect(final.status).toBe(200);
    await final.body?.cancel();
  });

  test('releases a slot after the response stream reaches its terminal chunk', async () => {
    let finish: (() => void) | undefined;
    const app = appWithLimit(1, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first'));
        finish = () => {
          controller.enqueue(new TextEncoder().encode('last'));
          controller.close();
        };
      },
    })));

    const response = await openRequest(app);
    const body = response.text();
    expect((await openRequest(app)).status).toBe(429);
    finish?.();
    expect(await body).toBe('firstlast');

    const next = await openRequest(app);
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  test('preserves upstream 429 semantics separately from a local concurrency 429', async () => {
    let calls = 0;
    const upstreamBody = '{"error":{"message":"upstream rate limit"}}';
    const app = appWithLimit(1, () => {
      calls += 1;
      return new Response(upstreamBody, {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'retry-after': '17',
          'x-upstream-request-id': 'upstream-123',
        },
      });
    });

    const upstream = await openRequest(app);
    const local = await openRequest(app);
    expect(calls).toBe(1);

    expect(upstream.status).toBe(429);
    expect(upstream.headers.get('retry-after')).toBe('17');
    expect(upstream.headers.get('x-upstream-request-id')).toBe('upstream-123');
    expect(await upstream.text()).toBe(upstreamBody);

    expect(local.status).toBe(429);
    expect(local.headers.get('retry-after')).toBe('1');
    expect(await local.json()).toMatchObject({
      error: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
    });
  });

  test('releases the slot after an upstream stream read error without replacing the error', async () => {
    const original = new Error('stream read failed');
    let first = true;
    const app = appWithLimit(1, () => {
      if (first) {
        first = false;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(original);
          },
        }));
      }
      return new Response('ok');
    });

    const broken = await openRequest(app);
    await expect(broken.text()).rejects.toBe(original);
    const next = await openRequest(app);
    expect(next.status).toBe(200);
    expect(await next.text()).toBe('ok');
  });

  test('releases the slot when the handler rejects and preserves the error chain', async () => {
    const original = new Error('upstream dispatch failed');
    let first = true;
    const app = appWithLimit(1, () => {
      if (first) {
        first = false;
        throw original;
      }
      return new Response('ok');
    });

    const failed = await openRequest(app);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ message: original.message });
    const next = await openRequest(app);
    expect(next.status).toBe(200);
    await next.text();
  });

  test('releases the slot when a request aborts during async handler work', async () => {
    const controller = new AbortController();
    const reason = new DOMException('client disconnected', 'AbortError');
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    let receivedError: unknown;
    let first = true;
    const app = new Hono();
    app.onError((error, c) => {
      receivedError = error;
      return c.json({ message: error.message }, 500);
    });
    app.use('*', createHardConcurrencyLimitMiddleware(() => 1));
    app.post('/v1/chat/completions', async c => {
      if (first) {
        first = false;
        markStarted?.();
        await new Promise<never>((_resolve, reject) => {
          c.req.raw.signal.addEventListener('abort', () => reject(c.req.raw.signal.reason), { once: true });
        });
      }
      return new Response('ok');
    });

    const pending = app.request('/v1/chat/completions', { method: 'POST', signal: controller.signal });
    await started;
    controller.abort(reason);
    const aborted = await pending;
    expect(aborted.status).toBe(500);
    expect(receivedError).toBe(reason);
    await aborted.body?.cancel();

    const next = await app.request('/v1/chat/completions', { method: 'POST' });
    expect(next.status).toBe(200);
    expect(await next.text()).toBe('ok');
  });

  test('does not apply the data-plane cap to control-plane routes or WebSocket upgrades', async () => {
    let calls = 0;
    const app = new Hono();
    app.use('*', createHardConcurrencyLimitMiddleware(() => 1));
    app.all('*', () => {
      calls += 1;
      return new Response('ok');
    });

    const held = await openRequest(app);
    expect((await app.request('/api/keys')).status).toBe(200);
    expect((await app.request('/v1/responses', { method: 'GET', headers: { upgrade: 'websocket' } })).status).toBe(200);
    expect(calls).toBe(3);
    await held.body?.cancel();
  });
});
