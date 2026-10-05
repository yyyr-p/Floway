import type { Context, Next } from 'hono';

import { getEnvOptional } from '@floway-dev/platform';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import { PUBLIC_DATA_PLANE_ROUTES, type PublicDataPlaneRouteId } from '@floway-dev/protocols/common';

const SOFT_LIMIT_ENV = 'FLOWAY_SOFT_CONCURRENT_REQUESTS';
const MAX_QUEUE_SIZE_ENV = 'FLOWAY_CONCURRENCY_QUEUE_MAX_SIZE';
const MAX_WAIT_MS_ENV = 'FLOWAY_CONCURRENCY_QUEUE_MAX_WAIT_MS';
const DEFAULT_MAX_QUEUE_SIZE = 100;
const MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const MAX_WAIT_MS = 2_147_483_647;
const RETRY_AFTER_SECONDS = '1';
const CONCURRENCY_LIMIT_MESSAGE = 'Too many concurrent requests. Retry the request shortly.';
const QUEUE_TIMEOUT_MESSAGE = 'Timed out waiting for a concurrency slot. Retry the request shortly.';

export interface SoftConcurrencyQueueConfig {
  limit: number | null;
  maxQueueSize: number;
  maxWaitMs: number;
}

type QueueAdmission = {
  release: () => void;
  queued: boolean;
  queuePosition: number;
  waitedMs: number;
};

type AcquireResult =
  | { kind: 'admitted'; admission: QueueAdmission }
  | { kind: 'full'; queueDepth: number }
  | { kind: 'timeout'; queueDepth: number; queuePosition: number; waitedMs: number };

interface Waiter {
  enqueuedAt: number;
  position: number;
  signal: AbortSignal;
  resolve: (result: AcquireResult) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  abort: () => void;
  settled: boolean;
}

const now = (): number => globalThis.performance?.now() ?? Date.now();

const parsePositiveInteger = (value: string, name: string, maximum: number): number => {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be a positive safe integer no greater than ${maximum}.`);
  }
  return parsed;
};

const parseQueueSize = (value: string): number => {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${MAX_QUEUE_SIZE_ENV} must be a non-negative integer.`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_QUEUE_SIZE) {
    throw new Error(`${MAX_QUEUE_SIZE_ENV} must be a non-negative safe integer no greater than ${MAX_QUEUE_SIZE}.`);
  }
  return parsed;
};

export const parseSoftConcurrencyQueueConfig = (values: {
  limit: string;
  maxQueueSize: string;
  maxWaitMs: string;
}): SoftConcurrencyQueueConfig => {
  const limitValue = values.limit.trim();
  const limit = limitValue === '' || limitValue === '0'
    ? null
    : parsePositiveInteger(limitValue, SOFT_LIMIT_ENV, Number.MAX_SAFE_INTEGER);
  const maxQueueSize = values.maxQueueSize.trim() === ''
    ? String(DEFAULT_MAX_QUEUE_SIZE)
    : values.maxQueueSize;
  const maxWaitMs = values.maxWaitMs.trim() === ''
    ? String(DEFAULT_MAX_WAIT_MS)
    : values.maxWaitMs;
  return {
    limit,
    maxQueueSize: parseQueueSize(maxQueueSize),
    maxWaitMs: parsePositiveInteger(maxWaitMs, MAX_WAIT_MS_ENV, MAX_WAIT_MS),
  };
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const routePatternRegex = (path: string): RegExp => {
  let source = '';
  let offset = 0;
  const parameter = /:[^/{}]+(?:\{([^}]+)\})?/g;
  for (const match of path.matchAll(parameter)) {
    const index = match.index ?? 0;
    source += escapeRegex(path.slice(offset, index));
    source += `(?:${match[1] ?? '[^/]+'})`;
    offset = index + match[0].length;
  }
  source += escapeRegex(path.slice(offset));
  return new RegExp(`^${source}$`);
};

const routeMatchers = Object.values(PUBLIC_DATA_PLANE_ROUTES).flatMap(route => route.paths.map(path => ({
  method: route.method,
  path: routePatternRegex(path),
})));

const routeMatches = (routeId: PublicDataPlaneRouteId, method: string, path: string): boolean => {
  const route = PUBLIC_DATA_PLANE_ROUTES[routeId];
  return route.method === method && route.paths.some(pattern => routePatternRegex(pattern).test(path));
};

const isDataPlaneRequest = (method: string, path: string): boolean =>
  routeMatchers.some(route => route.method === method && route.path.test(path));

const isAnthropicRoute = (method: string, path: string): boolean =>
  routeMatches('anthropicMessages', method, path)
  || routeMatches('anthropicMessagesCountTokens', method, path);

const isGeminiRoute = (method: string, path: string): boolean =>
  routeMatches('geminiGenerateContentAction', method, path)
  || routeMatches('geminiModels', method, path)
  || routeMatches('geminiModel', method, path);

const retryResponse = (
  c: Context,
  status: 'full' | 'timeout',
  queueDepth: number,
  queuePosition?: number,
  waitedMs?: number,
): Response => {
  const message = status === 'timeout' ? QUEUE_TIMEOUT_MESSAGE : CONCURRENCY_LIMIT_MESSAGE;
  c.header('Retry-After', RETRY_AFTER_SECONDS);
  c.header('Cache-Control', 'no-store');
  c.header('X-Floway-Queue-Status', status);
  c.header('X-Floway-Queue-Depth', String(queueDepth));
  if (queuePosition !== undefined) c.header('X-Floway-Queue-Position', String(queuePosition));
  if (waitedMs !== undefined) c.header('X-Floway-Queue-Wait-Ms', String(waitedMs));

  if (isAnthropicRoute(c.req.method, c.req.path)) {
    return c.json({
      type: 'error',
      error: { type: 'rate_limit_error', message },
      request_id: generateAnthropicId('req'),
    }, 429);
  }

  if (isGeminiRoute(c.req.method, c.req.path)) {
    return c.json({
      error: {
        code: 429,
        message,
        status: 'RESOURCE_EXHAUSTED',
      },
    }, 429);
  }

  return c.json({
    error: {
      message,
      type: 'rate_limit_error',
      param: null,
      code: 'rate_limit_exceeded',
    },
  }, 429);
};

const admissionHeaders = (response: Response, admission: QueueAdmission): Response => {
  if (!admission.queued) return response;
  const headers = new Headers(response.headers);
  headers.set('X-Floway-Queue-Status', 'admitted');
  headers.set('X-Floway-Queue-Position', String(admission.queuePosition));
  headers.set('X-Floway-Queue-Wait-Ms', String(admission.waitedMs));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Client disconnected while waiting for a concurrency slot.', 'AbortError');

class FifoConcurrencyQueue {
  private active = 0;
  private currentLimit: number | null;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number) {
    this.currentLimit = limit;
  }

  acquire(config: SoftConcurrencyQueueConfig, signal: AbortSignal): Promise<AcquireResult> {
    this.currentLimit = config.limit;
    this.drain();
    if (signal.aborted) return Promise.reject(abortReason(signal));

    const limit = config.limit;
    if (limit === null || (this.active < limit && this.waiters.length === 0)) {
      this.active += 1;
      return Promise.resolve({
        kind: 'admitted',
        admission: this.makeAdmission(false, 0, 0),
      });
    }

    if (this.waiters.length >= config.maxQueueSize) {
      return Promise.resolve({ kind: 'full', queueDepth: this.waiters.length });
    }

    return new Promise<AcquireResult>((resolve, reject) => {
      const enqueuedAt = now();
      const waiter: Waiter = {
        enqueuedAt,
        position: this.waiters.length + 1,
        signal,
        resolve,
        reject,
        timer: undefined,
        abort: () => undefined,
        settled: false,
      };
      const remove = (): boolean => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return false;
        this.waiters.splice(index, 1);
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        signal.removeEventListener('abort', waiter.abort);
        return true;
      };
      waiter.abort = () => {
        if (waiter.settled || !remove()) return;
        waiter.settled = true;
        reject(abortReason(signal));
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
      waiter.timer = setTimeout(() => {
        if (waiter.settled || !remove()) return;
        waiter.settled = true;
        resolve({
          kind: 'timeout',
          queueDepth: this.waiters.length,
          queuePosition: waiter.position,
          waitedMs: Math.max(0, Math.round(now() - waiter.enqueuedAt)),
        });
      }, config.maxWaitMs);
      if (signal.aborted) waiter.abort();
    });
  }

  private makeAdmission(queued: boolean, queuePosition: number, enqueuedAt: number): QueueAdmission {
    let released = false;
    return {
      queued,
      queuePosition,
      waitedMs: queued ? Math.max(0, Math.round(now() - enqueuedAt)) : 0,
      release: () => {
        if (released) return;
        released = true;
        this.active -= 1;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.waiters.length > 0 && (this.currentLimit === null || this.active < this.currentLimit)) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) continue;
      if (waiter.signal.aborted) {
        waiter.settled = true;
        if (waiter.timer !== undefined) clearTimeout(waiter.timer);
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.reject(abortReason(waiter.signal));
        continue;
      }
      waiter.settled = true;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.signal.removeEventListener('abort', waiter.abort);
      this.active += 1;
      waiter.resolve({
        kind: 'admitted',
        admission: this.makeAdmission(true, waiter.position, waiter.enqueuedAt),
      });
    }
  }
}

const holdUntilBodySettles = (
  response: Response,
  release: () => void,
  signal: AbortSignal,
): Response => {
  const body = response.body;
  if (body === null || response.status === 101) {
    release();
    return response;
  }

  const reader = body.getReader();
  let settled = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    signal.removeEventListener('abort', onAbort);
    release();
  };
  const onAbort = (): void => {
    void reader.cancel(abortReason(signal)).catch(error => {
      try {
        controllerRef?.error(error);
      } catch {
        // A disconnected client may already have cancelled the wrapped stream.
      }
    }).finally(finish);
  };

  const wrapped = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
    },
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          finish();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        try {
          controller.error(error);
        } finally {
          finish();
        }
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });

  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
};

export const createSoftConcurrencyQueueMiddleware = (
  getConfig: () => SoftConcurrencyQueueConfig,
) => {
  let queue: FifoConcurrencyQueue | undefined;

  return async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method;
    const path = c.req.path;
    if (c.req.header('upgrade')?.toLowerCase() === 'websocket' || !isDataPlaneRequest(method, path)) {
      return await next();
    }

    const config = getConfig();
    if (config.limit === null) return await next();
    queue ??= new FifoConcurrencyQueue(config.limit);

    const result = await queue.acquire(config, c.req.raw.signal);
    if (result.kind === 'full') return retryResponse(c, 'full', result.queueDepth);
    if (result.kind === 'timeout') {
      return retryResponse(c, 'timeout', result.queueDepth, result.queuePosition, result.waitedMs);
    }

    try {
      await next();
      const withHeaders = admissionHeaders(c.res, result.admission);
      c.res = holdUntilBodySettles(withHeaders, result.admission.release, c.req.raw.signal);
    } catch (error) {
      result.admission.release();
      throw error;
    }
  };
};

const configuredSoftConcurrencyQueue = (): SoftConcurrencyQueueConfig => parseSoftConcurrencyQueueConfig({
  limit: getEnvOptional(SOFT_LIMIT_ENV, ''),
  maxQueueSize: getEnvOptional(MAX_QUEUE_SIZE_ENV, String(DEFAULT_MAX_QUEUE_SIZE)),
  maxWaitMs: getEnvOptional(MAX_WAIT_MS_ENV, String(DEFAULT_MAX_WAIT_MS)),
});

// This queue is intentionally local to the gateway application instance: it is
// per Node process and per Cloudflare Worker isolate, not globally coordinated.
export const softConcurrencyQueueMiddleware = createSoftConcurrencyQueueMiddleware(configuredSoftConcurrencyQueue);
