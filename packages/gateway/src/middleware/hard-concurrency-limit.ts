import type { Context, Next } from 'hono';

import { getEnvOptional } from '@floway-dev/platform';
import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import { PUBLIC_DATA_PLANE_ROUTES, type PublicDataPlaneRouteId } from '@floway-dev/protocols/common';

const LIMIT_ENV = 'FLOWAY_MAX_CONCURRENT_REQUESTS';
const RETRY_AFTER_SECONDS = '1';
const CONCURRENCY_LIMIT_MESSAGE = 'Too many concurrent requests. Retry the request shortly.';

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

const routeMatchers = Object.values(PUBLIC_DATA_PLANE_ROUTES).flatMap(route => route.paths.map(path => ({ method: route.method, path: routePatternRegex(path) })));

const routeMatches = (routeId: PublicDataPlaneRouteId, method: string, path: string): boolean => {
  const route = PUBLIC_DATA_PLANE_ROUTES[routeId];
  return route.method === method && route.paths.some(pattern => routePatternRegex(pattern).test(path));
};

const isDataPlaneRequest = (method: string, path: string): boolean =>
  routeMatchers.some(route => route.method === method && route.path.test(path));

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

const isAnthropicRoute = (method: string, path: string): boolean =>
  routeMatches('anthropicMessages', method, path)
  || routeMatches('anthropicMessagesCountTokens', method, path);

const isGeminiRoute = (method: string, path: string): boolean =>
  routeMatches('geminiGenerateContentAction', method, path)
  || routeMatches('geminiModels', method, path)
  || routeMatches('geminiModel', method, path);

const rateLimitResponse = (c: Context): Response => {
  c.header('Retry-After', RETRY_AFTER_SECONDS);
  c.header('Cache-Control', 'no-store');

  if (isAnthropicRoute(c.req.method, c.req.path)) {
    return c.json({
      type: 'error',
      error: { type: 'rate_limit_error', message: CONCURRENCY_LIMIT_MESSAGE },
      request_id: generateAnthropicId('req'),
    }, 429);
  }

  if (isGeminiRoute(c.req.method, c.req.path)) {
    return c.json({
      error: {
        code: 429,
        message: CONCURRENCY_LIMIT_MESSAGE,
        status: 'RESOURCE_EXHAUSTED',
      },
    }, 429);
  }

  return c.json({
    error: {
      message: CONCURRENCY_LIMIT_MESSAGE,
      type: 'rate_limit_error',
      param: null,
      code: 'rate_limit_exceeded',
    },
  }, 429);
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
    if (inFlight >= limit) return rateLimitResponse(c);

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
