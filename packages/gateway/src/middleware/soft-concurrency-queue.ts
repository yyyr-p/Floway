import type { Context, Next } from 'hono';

import { concurrencyAbortReason, holdConcurrencyResponseStream } from './concurrency-response-stream.ts';
import { concurrencyLimitResponse, isDataPlaneRequest } from './concurrency-response.ts';
import { getEnvOptional } from '@floway-dev/platform';

const SOFT_LIMIT_ENV = 'FLOWAY_SOFT_CONCURRENT_REQUESTS';
const MAX_QUEUE_SIZE_ENV = 'FLOWAY_CONCURRENCY_QUEUE_MAX_SIZE';
const MAX_WAIT_MS_ENV = 'FLOWAY_CONCURRENCY_QUEUE_MAX_WAIT_MS';
const DEFAULT_MAX_QUEUE_SIZE = 100;
const MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const MAX_WAIT_MS = 2_147_483_647;
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

const retryResponse = (
  c: Context,
  status: 'full' | 'timeout',
  queueDepth: number,
  queuePosition?: number,
  waitedMs?: number,
): Response => {
  const message = status === 'timeout' ? QUEUE_TIMEOUT_MESSAGE : CONCURRENCY_LIMIT_MESSAGE;
  return concurrencyLimitResponse(c, message, {
    status,
    depth: queueDepth,
    ...(queuePosition === undefined ? {} : { position: queuePosition }),
    ...(waitedMs === undefined ? {} : { waitedMs }),
  });
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
    if (signal.aborted) return Promise.reject(concurrencyAbortReason(signal));

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
        reject(concurrencyAbortReason(signal));
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
        waiter.reject(concurrencyAbortReason(waiter.signal));
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
      c.res = holdConcurrencyResponseStream(withHeaders, result.admission.release, c.req.raw.signal);
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
