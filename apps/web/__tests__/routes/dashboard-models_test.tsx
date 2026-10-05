import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '../../src/i18n';
import DashboardModels from '../../src/routes/dashboard-models';
import { aliasModel, catalogModel } from '../api/model-fixture';
import { renderInApp } from '../render';

const dashboardState = vi.hoisted(() => ({ user: { isAdmin: false as boolean, upstreamIds: ['allowed'] as string[] | null } }));

vi.mock('../../src/routes/dashboard', () => ({
  useDashboardOutletContext: () => ({ user: dashboardState.user }),
}));

const renderPage = (models: ReturnType<typeof catalogModel>[] | null, status: number | null = null) =>
  renderInApp(<DashboardModels
    loaderData={{ models, error: status === null ? null : { status } }}
    matches={[] as never}
    params={{}}
  />);

describe('model catalog route', () => {
  beforeEach(() => {
    dashboardState.user = { isAdmin: false, upstreamIds: ['allowed'] };
  });

  it('keeps non-admin results inside the user upstream scope, including aliases', () => {
    renderPage([
      catalogModel('allowed-id', { display_name: 'Allowed model', upstreams: ['allowed'] }),
      catalogModel('blocked-id', { display_name: 'Blocked model', upstreams: ['blocked'] }),
      aliasModel('allowed-alias', ['allowed-id'], { display_name: 'Allowed alias' }),
      aliasModel('blocked-alias', ['blocked-id'], { display_name: 'Blocked alias' }),
    ]);

    expect(screen.getByText('Allowed model')).toBeTruthy();
    expect(screen.getByText('Allowed alias')).toBeTruthy();
    expect(screen.queryByText('Blocked model')).toBeNull();
    expect(screen.queryByText('Blocked alias')).toBeNull();
  });

  it('shows the gateway-wide catalog to administrators', () => {
    dashboardState.user = { isAdmin: true, upstreamIds: ['allowed'] };
    renderPage([
      catalogModel('allowed-id', { display_name: 'Allowed model', upstreams: ['allowed'] }),
      catalogModel('blocked-id', { display_name: 'Gateway model', upstreams: ['blocked'] }),
    ]);

    expect(screen.getByText('Allowed model')).toBeTruthy();
    expect(screen.getByText('Gateway model')).toBeTruthy();
  });

  it('distinguishes a real empty catalog from a failed request', () => {
    const loadingPage = renderPage(null);
    expect(screen.getByText(i18n.t('dashboard.modelsCatalog.loading'))).toBeTruthy();
    loadingPage.unmount();

    const emptyPage = renderPage([]);
    expect(screen.getByText(i18n.t('dashboard.modelsCatalog.empty'))).toBeTruthy();
    emptyPage.unmount();

    const connectionPage = renderPage(null, 0);
    expect(screen.getByText(i18n.t('dashboard.modelsCatalog.errors.connection'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('dashboard.modelsCatalog.empty'))).toBeNull();
    connectionPage.unmount();

    renderPage(null, 502);
    expect(screen.getByText(i18n.t('dashboard.modelsCatalog.errors.http', { status: 502 }))).toBeTruthy();
    expect(screen.queryByText(i18n.t('dashboard.modelsCatalog.empty'))).toBeNull();
    expect(screen.getByRole('button', { name: i18n.t('dashboard.modelsCatalog.actions.refresh') })).toBeTruthy();
  });
});
