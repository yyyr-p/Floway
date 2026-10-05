import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { VisibleUpstream } from '../../../src/api/types';
import { UserUpstreamDirectory } from '../../../src/components/upstreams/user-directory';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const upstreams: VisibleUpstream[] = [
  { id: 'up_public', name: 'Shared endpoint', kind: 'custom', hue: 210 },
];

describe('user upstream directory', () => {
  it('shows only the safe identity summary without management actions', () => {
    renderInApp(<UserUpstreamDirectory loadFailed={false} upstreams={upstreams} />);

    expect(screen.getByRole('table', { name: i18n.t('dashboard.upstreams.directory.tableLabel') })).toBeTruthy();
    expect(screen.getByText('Shared endpoint')).toBeTruthy();
    expect(screen.getByText(i18n.t('provider.custom'))).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('distinguishes a failed directory fetch from an empty directory', () => {
    renderInApp(<UserUpstreamDirectory loadFailed upstreams={null} />);

    expect(screen.getByText(i18n.t('dashboard.upstreams.directory.loadFailed'))).toBeTruthy();
    expect(screen.queryByText(i18n.t('dashboard.upstreams.directory.empty'))).toBeNull();
  });
});
