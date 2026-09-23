import { act, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import type { UpstreamOption } from '../../../src/api/types';
import { UpstreamAccessControl } from '../../../src/components/upstreams/access-control';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const available: UpstreamOption[] = [
  { id: 'up_a', name: 'Alpha', kind: 'custom', enabled: true, hue: 210, cachedModelCount: 1 },
];

const Control = ({ error, initialIds }: { error?: string | null; initialIds: string[] }) => {
  const [value, setValue] = useState({ override: true, ids: initialIds });
  return <UpstreamAccessControl available={available} disabled={false} error={error} ids={value.ids} models={[]} onChange={setValue} override={value.override} />;
};

const click = async (element: HTMLElement) => {
  await act(async () => { element.click(); });
};

describe('upstream access selection', () => {
  it('reveals a validation error from a collapsed list and keeps correction controls open after it clears', () => {
    const { rerender } = renderInApp(<Control initialIds={[]} />);
    const disclosure = screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');

    const error = i18n.t('dashboard.upstreamAccess.validation');
    rerender(<Control error={error} initialIds={[]} />);
    const alert = screen.getByText(error);
    expect(alert.getAttribute('role')).toBe('alert');
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(alert.closest('[inert]')).toBeNull();
    const warning = screen.getByText(i18n.t('dashboard.upstreamAccess.emptyWarning')).closest('.fui-MessageBar');
    expect(alert.closest('section')?.getAttribute('aria-describedby')?.split(' ')).toEqual([alert.id, warning?.id]);

    rerender(<Control error={null} initialIds={[]} />);
    expect(screen.queryByText(error)).toBeNull();
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  });

  it('makes an error present on mount accessible immediately', () => {
    const error = i18n.t('dashboard.upstreamAccess.validation');
    renderInApp(<Control error={error} initialIds={[]} />);
    expect(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(error).closest('[inert]')).toBeNull();
  });

  it('warns immediately for a saved empty selection even while the list is collapsed', async () => {
    renderInApp(<Control initialIds={[]} />);
    const warning = i18n.t('dashboard.upstreamAccess.emptyWarning');
    expect(screen.getByText(warning).closest('.fui-MessageBar')).not.toBeNull();
    expect(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }).getAttribute('aria-expanded')).toBe('false');

    const toggle = screen.getByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') });
    await click(toggle);
    expect(screen.queryByText(warning)).toBeNull();
    await click(toggle);
    expect(screen.getByText(warning)).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Enabled: Alpha' }) as HTMLInputElement).checked).toBe(false);
  });

  it('keeps a row on its own element when the tick moves it out of the ordered head', async () => {
    renderInApp(<Control initialIds={['up_a']} />);
    await click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }));
    const checkbox = screen.getByRole('checkbox', { name: 'Enabled: Alpha' });
    await click(checkbox);
    // Rebuilding the row instead of moving it takes the focus of whoever just
    // ticked the box, and leaves them pressing a node the document dropped.
    expect(screen.getByRole('checkbox', { name: 'Enabled: Alpha' })).toBe(checkbox);
    expect(checkbox.isConnected).toBe(true);
  });

  it('places the reorder grip after the checkbox in the enabled cell', async () => {
    renderInApp(<Control initialIds={['up_a']} />);
    await click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }));
    const checkbox = screen.getByRole('checkbox', { name: 'Enabled: Alpha' });
    const grip = screen.getByRole('button', { name: 'Reorder upstream Alpha' });

    expect(checkbox.closest('td')).toBe(grip.closest('td'));
    expect(checkbox.compareDocumentPosition(grip) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(screen.queryByRole('columnheader', { name: 'Order' })).toBeNull();
  });

  it('allows deselecting the last upstream and preserves selections across the limit switch', async () => {
    renderInApp(<Control initialIds={['up_a']} />);
    await click(screen.getByRole('button', { name: i18n.t('dashboard.upstreamAccess.title') }));
    const checkbox = screen.getByRole('checkbox', { name: 'Enabled: Alpha' }) as HTMLInputElement;
    const warning = i18n.t('dashboard.upstreamAccess.emptyWarning');
    expect(screen.queryByText(warning)).toBeNull();
    await click(checkbox);
    expect(screen.getByText(warning)).toBeTruthy();
    await click(checkbox);
    expect(screen.queryByText(warning)).toBeNull();
    const toggle = screen.getByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') });
    await click(toggle);
    await click(toggle);
    expect((screen.getByRole('checkbox', { name: 'Enabled: Alpha' }) as HTMLInputElement).checked).toBe(true);
  });
});
