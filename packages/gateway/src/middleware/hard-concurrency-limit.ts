import type { Context, Next } from 'hono';

import { concurrencyLimitResponse, isDataPlaneRequest } from './concurrency-response.ts';
import { getEnvOptional } from '@floway-dev/platform';

const LIMIT_ENV = 'FLOWAY_MAX_CONCURRENT_REQUESTS';
const CONCURRENCY_LIMIT_MESSAGE = 'Too many concurrent requests. Retry the request shortly.';

export const parseHardConcurrentRequestLimit = (value: string): number | null => {
  const normalized = value.trim();
  if (normalized === '' || normalized === '0') return null;
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`${LIMIT_ENV} must be a positive integer or 0.`);
  }
  const limit = Number(normalized);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error(`${LIMIT_ENV} must be a positive safe integer or 0.`);
  }
  return limit;
};

const holdUntilBodySettles = (response: Response, release: () => void): Response => {
  const body = response.body;
  if (body === null || response.status === 101) {
    release();
    return response;
  }

  const reader = body.getReader();
  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(result.value);
      } catch (error) {
        try {
          controller.error(error);
        } finally {
          release();
        }
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
};

export const createHardConcurrencyLimitMiddleware = (
  getLimit: () => number | null,
) => {
  // One counter per gateway app instance; it is not shared across processes or Worker isolates.
  let inFlight = 0;

  return async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method;
    const path = c.req.path;
    const isWebSocketUpgrade = c.req.header('upgrade')?.toLowerCase() === 'websocket';
    if (isWebSocketUpgrade || !isDataPlaneRequest(method, path)) return await next();

    const limit = getLimit();
    if (limit === null) return await next();
    if (inFlight >= limit) return concurrencyLimitResponse(c, CONCURRENCY_LIMIT_MESSAGE);

    inFlight += 1;
    let acquired = true;
    const release = (): void => {
      if (!acquired) return;
      acquired = false;
      inFlight -= 1;
    };

    try {
      await next();
      c.res = holdUntilBodySettles(c.res, release);
    } catch (error) {
      release();
      throw error;
    }
  };
};

const configuredHardConcurrencyLimit = () => parseHardConcurrentRequestLimit(getEnvOptional(LIMIT_ENV, ''));

export const hardConcurrencyLimitMiddleware = createHardConcurrencyLimitMiddleware(configuredHardConcurrencyLimit);
