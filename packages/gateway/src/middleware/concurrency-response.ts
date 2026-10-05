import type { Context } from 'hono';

import { generateAnthropicId } from '@floway-dev/protocols/anthropic-messages';
import { PUBLIC_DATA_PLANE_ROUTES, type PublicDataPlaneRouteId } from '@floway-dev/protocols/common';

const RETRY_AFTER_SECONDS = '1';

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

const routeMatchers = Object.entries(PUBLIC_DATA_PLANE_ROUTES).flatMap(([routeId, route]) => route.paths.map(path => ({
  routeId,
  method: route.method,
  path: routePatternRegex(path),
})));

const routeMatches = (routeId: PublicDataPlaneRouteId, method: string, path: string): boolean =>
  routeMatchers.some(route => route.routeId === routeId && route.method === method && route.path.test(path));

export const isDataPlaneRequest = (method: string, path: string): boolean =>
  routeMatchers.some(route => route.method === method && route.path.test(path));

interface QueueRejectionHeaders {
  status: 'full' | 'timeout';
  depth: number;
  position?: number;
  waitedMs?: number;
}

export const concurrencyLimitResponse = (
  c: Context,
  message: string,
  queue?: QueueRejectionHeaders,
): Response => {
  c.header('Retry-After', RETRY_AFTER_SECONDS);
  c.header('Cache-Control', 'no-store');
  if (queue) {
    c.header('X-Floway-Queue-Status', queue.status);
    c.header('X-Floway-Queue-Depth', String(queue.depth));
    if (queue.position !== undefined) c.header('X-Floway-Queue-Position', String(queue.position));
    if (queue.waitedMs !== undefined) c.header('X-Floway-Queue-Wait-Ms', String(queue.waitedMs));
  }

  if (
    routeMatches('anthropicMessages', c.req.method, c.req.path)
    || routeMatches('anthropicMessagesCountTokens', c.req.method, c.req.path)
  ) {
    return c.json({
      type: 'error',
      error: { type: 'rate_limit_error', message },
      request_id: generateAnthropicId('req'),
    }, 429);
  }

  if (
    routeMatches('geminiGenerateContentAction', c.req.method, c.req.path)
    || routeMatches('geminiModels', c.req.method, c.req.path)
    || routeMatches('geminiModel', c.req.method, c.req.path)
  ) {
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
