import { test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const adminRequest = (session: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-floway-session': session },
  body: JSON.stringify(body),
});

test('custom usage probe reads the draft endpoint and returns only projected limits', async () => {
  const { adminSession } = await setupAppTest();
  const record = buildCustomUpstreamRecord({
    id: '',
    config: {
      baseUrl: 'https://custom.example.com/prefix',
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
      usageProbe: {
        path: '/account/usage',
        windows: [{ id: 'week', label: 'Weekly', used: '/usage/used', limit: '/usage/limit', resetAt: '/usage/reset_at' }],
      },
    },
  });

  await withMockedFetch(async request => {
    assertEquals(request.url, 'https://custom.example.com/prefix/account/usage');
    assertEquals(request.headers.get('authorization'), 'Bearer sk-custom');
    return jsonResponse({ usage: { used: 20, limit: 80, reset_at: '2026-10-06T00:00:00Z' } });
  }, async () => {
    const response = await requestApp('/api/upstreams/custom/usage', adminRequest(adminSession, {
      record: { ...record, proxy_fallback_list: MOCKED_FETCH_EGRESS },
    }));
    assertEquals(response.status, 200);
    const body = await response.json() as { observation: { windows: unknown[] } };
    assertEquals(body.observation.windows, [{
      id: 'week',
      label: 'Weekly',
      used: 20,
      limit: 80,
      percent: 25,
      resetAt: '2026-10-06T00:00:00.000Z',
    }]);
  });
});

test('custom action execution uses the saved action and never returns its response body', async () => {
  const { repo, adminSession } = await setupAppTest();
  const record = buildCustomUpstreamRecord({
    id: 'up_custom_action',
    config: {
      baseUrl: 'https://custom.example.com/prefix',
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: { openaiChatCompletions: {} },
      ingressHeadersRules: [],
      actions: [{ id: 'reset', label: 'Reset quota', path: '/account/reset', method: 'POST', body: { scope: 'weekly' } }],
    },
  });
  await saveUpstreamForTest(repo.upstreams, record);

  await withMockedFetch(async request => {
    assertEquals(request.url, 'https://custom.example.com/prefix/account/reset');
    assertEquals(request.method, 'POST');
    assertEquals(request.headers.get('authorization'), 'Bearer sk-custom');
    assertEquals(await request.text(), JSON.stringify({ scope: 'weekly' }));
    return jsonResponse({ private: 'upstream response body' }, 202);
  }, async () => {
    const response = await requestApp('/api/upstreams/custom/actions/execute', adminRequest(adminSession, {
      upstreamId: record.id,
      actionId: 'reset',
      confirmed: true,
    }));
    assertEquals(response.status, 200);
    assertEquals(await response.json(), { ok: true, status: 202 });
  });

  const missing = await requestApp('/api/upstreams/custom/actions/execute', adminRequest(adminSession, {
    upstreamId: record.id,
    actionId: 'not-configured',
    confirmed: true,
  }));
  assertEquals(missing.status, 404);
});

test('custom management routes require an admin session', async () => {
  const { repo } = await setupAppTest();
  const nonAdminSession = (await repo.sessions.create(2)).id;
  const response = await requestApp('/api/upstreams/custom/actions/execute', adminRequest(nonAdminSession, {
    upstreamId: 'up_custom',
    actionId: 'reset',
    confirmed: true,
  }));
  assertEquals(response.status, 403);
});
