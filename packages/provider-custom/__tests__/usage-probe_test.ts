import { test } from 'vitest';

import { assertCustomUpstreamRecord, executeCustomOperationalAction, fetchCustomUsageProbe } from '../src/index.ts';
import type { Fetcher, FetchInit, UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const customConfig = (usageProbe: unknown) => assertCustomUpstreamRecord({
  id: 'up_test',
  kind: 'custom',
  name: 'Test Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com/base',
    authStyle: 'bearer',
    apiKey: 'secret-test-key',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    usageProbe,
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
} as UpstreamRecord).config;

const probe = {
  path: '/account/usage',
  windows: [
    { id: 'weekly', label: 'Weekly', used: '/usage/used', limit: '/usage/limit', resetAt: '/usage/reset_at' },
    { id: 'daily', label: 'Daily', used: '/windows/0/used', limit: '/windows/0/limit' },
  ],
};

test('fetchCustomUsageProbe applies upstream authentication and projects configured JSON Pointer windows', async () => {
  let requestUrl = '';
  let requestInit: FetchInit | undefined;
  const fetcher: Fetcher = async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return Response.json({
      usage: { used: '250', limit: 1000, reset_at: '2026-10-06T00:00:00Z' },
      windows: [{ used: 5, limit: 10 }],
    });
  };

  const observation = await fetchCustomUsageProbe(customConfig(probe), fetcher);

  assertEquals(requestUrl, 'https://custom.example.com/base/account/usage');
  assertEquals(new Headers(requestInit?.headers).get('authorization'), 'Bearer secret-test-key');
  assertEquals(requestInit?.redirect, 'manual');
  assertEquals(observation.windows, [
    { id: 'weekly', label: 'Weekly', used: 250, limit: 1000, percent: 25, resetAt: '2026-10-06T00:00:00.000Z' },
    { id: 'daily', label: 'Daily', used: 5, limit: 10, percent: 50, resetAt: null },
  ]);
});

test('fetchCustomUsageProbe refuses redirects and does not forward auth to a redirect target', async () => {
  let requests = 0;
  const fetcher: Fetcher = async (_url, init) => {
    requests += 1;
    assertEquals(init.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://other.example/steal' } });
  };

  await assertRejects(
    () => fetchCustomUsageProbe(customConfig(probe), fetcher),
    Error,
    'refused redirect response 302',
  );
  assertEquals(requests, 1);
});

test('fetchCustomUsageProbe rejects oversized or unmappable responses without returning raw payloads', async () => {
  const oversizedFetcher: Fetcher = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1));
      controller.close();
    },
  }));
  await assertRejects(
    () => fetchCustomUsageProbe(customConfig(probe), oversizedFetcher),
    Error,
    'could not be read as bounded JSON',
  );

  const malformedFetcher: Fetcher = async () => Response.json({ usage: { used: 'not-a-number', limit: 10 }, windows: [] });
  await assertRejects(
    () => fetchCustomUsageProbe(customConfig(probe), malformedFetcher),
    Error,
    'weekly.used must resolve to a non-negative number',
  );
});

test('executeCustomOperationalAction only executes configured actions and returns status metadata', async () => {
  let requestUrl = '';
  let requestInit: FetchInit | undefined;
  const fetcher: Fetcher = async (url, init) => {
    requestUrl = url;
    requestInit = init;
    return new Response(null, { status: 204 });
  };
  const config = assertCustomUpstreamRecord({
    id: 'up_test',
    kind: 'custom',
    name: 'Test Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    config: {
      baseUrl: 'https://custom.example.com/base',
      authStyle: 'bearer',
      apiKey: 'secret-test-key',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
      actions: [{ id: 'reset', label: 'Reset quota', path: '/account/reset', method: 'POST', body: { scope: 'weekly' } }],
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  } as UpstreamRecord).config;

  assertEquals(await executeCustomOperationalAction(config, 'reset', fetcher), { ok: true, status: 204 });
  assertEquals(requestUrl, 'https://custom.example.com/base/account/reset');
  assertEquals(new Headers(requestInit?.headers).get('authorization'), 'Bearer secret-test-key');
  assertEquals(requestInit?.method, 'POST');
  assertEquals(requestInit?.redirect, 'manual');
  assertEquals(requestInit?.body, JSON.stringify({ scope: 'weekly' }));
  await assertRejects(
    () => executeCustomOperationalAction(config, 'unknown', fetcher),
    Error,
    'not configured',
  );
});

test('executeCustomOperationalAction refuses redirects without following them', async () => {
  let requests = 0;
  const fetcher: Fetcher = async () => {
    requests += 1;
    return new Response(null, { status: 303, headers: { location: 'https://other.example/action' } });
  };
  const config = assertCustomUpstreamRecord({
    id: 'up_test',
    kind: 'custom',
    name: 'Test Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-29T00:00:00.000Z',
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'none',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
      actions: [{ id: 'reset', label: 'Reset quota', path: '/account/reset', method: 'POST' }],
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
  } as UpstreamRecord).config;

  await assertRejects(
    () => executeCustomOperationalAction(config, 'reset', fetcher),
    Error,
    'refused redirect response 303',
  );
  assertEquals(requests, 1);
});
