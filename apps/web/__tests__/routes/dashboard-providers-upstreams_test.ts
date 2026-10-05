import { beforeEach, expect, test, vi } from 'vitest';

import { clientLoader } from '../../src/routes/dashboard-providers-upstreams';

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  models: vi.fn(),
  upstreams: vi.fn(),
  user: vi.fn(),
}));

vi.mock('../../src/routes/guards', () => ({ requireDashboardUser: mocks.user }));
vi.mock('../../src/api/client', () => ({
  api: {
    api: {
      'upstream-directory': { $get: mocks.directory },
      models: { $get: mocks.models },
      upstreams: { $get: mocks.upstreams },
    },
  },
  callApi: (operation: () => unknown) => operation(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.directory.mockResolvedValue({ data: [{ id: 'up_visible', name: 'Shared', kind: 'custom', hue: 210 }], error: null });
  mocks.upstreams.mockResolvedValue({ data: [], error: null });
  mocks.models.mockResolvedValue({ data: { data: [] }, error: null });
});

test('ordinary users load only the safe visible directory', async () => {
  mocks.user.mockResolvedValue({ id: 2, isAdmin: false });

  const result = await clientLoader();

  expect(result).toEqual({
    role: 'user',
    upstreams: [{ id: 'up_visible', name: 'Shared', kind: 'custom', hue: 210 }],
    loadFailed: false,
  });
  expect(mocks.directory).toHaveBeenCalledTimes(1);
  expect(mocks.upstreams).not.toHaveBeenCalled();
  expect(mocks.models).not.toHaveBeenCalled();
});

test('administrators keep loading the full management dataset', async () => {
  mocks.user.mockResolvedValue({ id: 1, isAdmin: true });

  const result = await clientLoader();

  expect(result).toMatchObject({ role: 'admin', upstreams: [], models: [] });
  expect(mocks.directory).not.toHaveBeenCalled();
  expect(mocks.upstreams).toHaveBeenCalledTimes(1);
  expect(mocks.models).toHaveBeenCalledTimes(1);
});
