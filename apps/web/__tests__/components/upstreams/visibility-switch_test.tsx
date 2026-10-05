import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { UpstreamVisibilitySwitch } from '../../../src/components/upstreams/visibility-switch';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

describe('upstream visibility control', () => {
  it('lets an administrator change ordinary-user visibility', async () => {
    const onChange = vi.fn();
    renderInApp(<UpstreamVisibilitySwitch checked={false} disabled={false} name="Shared endpoint" onChange={onChange} />);
    const toggle = screen.getByRole('switch', {
      name: i18n.t('dashboard.upstreams.actions.toggleVisibilityNamed', { name: 'Shared endpoint' }),
    });

    await act(async () => { toggle.click(); });

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not allow changing visibility during a page mutation', () => {
    renderInApp(<UpstreamVisibilitySwitch checked={true} disabled name="Shared endpoint" onChange={vi.fn()} />);
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
  });
});
