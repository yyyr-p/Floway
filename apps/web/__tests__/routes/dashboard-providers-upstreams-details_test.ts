import { beforeEach, expect, test, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-providers-upstreams-details';

const mocks = vi.hoisted(() => ({ get: vi.fn(), requireAdmin: vi.fn() }));

vi.mock('../../src/routes/guards', () => ({ requireDashboardAdmin: mocks.requireAdmin }));
vi.mock('../../src/api/client', () => ({
  api: { api: { upstreams: { ':id': { $get: mocks.get } } } },
  callApi: (operation: () => unknown) => operation(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: {
      id: 'up_subscription',
      kind: 'copilot',
      config: { githubHost: 'github.com', user: { id: '123', login: 'octocat', name: null } },
      state: { copilotToken: null, seat: null, quotaSnapshot: null },
    }, error: undefined,
  });
});

test('the details loader requires admin access and loads the addressed subscription upstream', async () => {
  const loaded = await clientLoader({ params: { id: 'up_subscription' } } as Parameters<typeof clientLoader>[0]);

  expect(mocks.requireAdmin).toHaveBeenCalledOnce();
  expect(mocks.get).toHaveBeenCalledOnce();
  expect(loaded.record.id).toBe('up_subscription');
});

test('non-subscription upstreams are sent back to the editor', async () => {
  mocks.get.mockResolvedValue({ data: { id: 'up_custom', kind: 'custom', config: { baseUrl: 'https://example.test' } }, error: undefined });

  const thrown = await clientLoader({ params: { id: 'up_custom' } } as Parameters<typeof clientLoader>[0]).then(() => null, error => error);

  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(302);
  expect((thrown as Response).headers.get('location')).toBe('/dashboard/providers/upstreams/up_custom');
});

test('a missing upstream returns to the list with the existing missing-record signal', async () => {
  mocks.get.mockResolvedValue({ data: undefined, error: { status: 404, message: 'not found' } });

  const thrown = await clientLoader({ params: { id: 'up_missing' } } as Parameters<typeof clientLoader>[0]).then(() => null, error => error);

  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).headers.get('location')).toBe('/dashboard/providers/upstreams?missing=1');
});
