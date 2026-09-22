import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ControlPlaneUser } from '../../../src/api/types';
import { OutcomeToastProvider } from '../../../src/components/ui/outcome-toast';
import { UserDialog } from '../../../src/components/users/dialog';
import { i18n } from '../../../src/i18n';
import { renderInApp } from '../../render';

const user: ControlPlaneUser = {
  id: 2, username: 'restricted', isAdmin: false, canViewGlobalUsage: false, upstreamIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => vi.unstubAllGlobals());

describe('user upstream limits', () => {
  it.each(['create', 'edit'] as const)('saves %s with an empty limit or no limit', async mode => {
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      // The edit dialog loads the OAuth2 accounts for the user on mount; feed
      // it an empty list so the OAuth2 panel renders its empty state rather
      // than misinterpreting the user record as an account payload.
      if (String(input).includes('/oauth2-accounts')) {
        return Response.json({ accounts: [] });
      }
      return Response.json(user);
    });
    vi.stubGlobal('fetch', fetch);
    const onSaved = vi.fn(async () => {});
    renderInApp(<OutcomeToastProvider><UserDialog
      {...(mode === 'create' ? { mode } : { mode, user })}
      actorId={1} models={[]} onOpenChange={vi.fn()} onSaved={onSaved} open upstreams={[]}
    /></OutcomeToastProvider>);
    const toggle = screen.getByRole('switch', { name: i18n.t('dashboard.upstreamAccess.title') });
    if (mode === 'create') {
      await act(async () => {
        fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.username')), { target: { value: 'restricted' } });
        fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.password')), { target: { value: 'password' } });
        toggle.click();
      });
    }
    expect(screen.getByText(i18n.t('dashboard.upstreamAccess.emptyWarning'))).toBeTruthy();
    const save = screen.getByRole('button', { name: i18n.t(mode === 'create' ? 'dashboard.users.actions.create' : 'dashboard.users.actions.save') });
    await act(async () => { save.click(); });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenLastCalledWith(mode === 'create' ? '/api/users' : '/api/users/2', expect.objectContaining({
      method: mode === 'create' ? 'POST' : 'PATCH',
      body: expect.stringContaining('"upstreamIds":[]'),
    }));

    await act(async () => { toggle.click(); });
    expect(screen.queryByText(i18n.t('dashboard.upstreamAccess.emptyWarning'))).toBeNull();
    await act(async () => { save.click(); });
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(mode === 'create' ? '/api/users' : '/api/users/2', expect.objectContaining({
      body: expect.stringContaining('"upstreamIds":null'),
    }));
  });
});

it.each(['create', 'edit'] as const)('saves the independent global usage grant in %s mode', async mode => {
  const fetch = vi.fn(async (input: RequestInfo | URL) => String(input).includes('/oauth2-accounts')
    ? Response.json({ accounts: [] }) : Response.json(user));
  vi.stubGlobal('fetch', fetch);
  renderInApp(<OutcomeToastProvider><UserDialog
    {...(mode === 'create' ? { mode } : { mode, user })}
    actorId={1} models={[]} onOpenChange={vi.fn()} onSaved={vi.fn(async () => {})} open upstreams={[]}
  /></OutcomeToastProvider>);
  const grant = screen.getByRole('switch', { name: i18n.t('dashboard.users.form.globalUsage') });
  expect((grant as HTMLInputElement).checked).toBe(false);
  await act(async () => {
    if (mode === 'create') {
      fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.username')), { target: { value: 'reader' } });
      fireEvent.change(screen.getByLabelText(i18n.t('dashboard.users.form.password')), { target: { value: 'password' } });
    }
    grant.click();
  });
  await act(async () => {
    screen.getByRole('button', { name: i18n.t(mode === 'create' ? 'dashboard.users.actions.create' : 'dashboard.users.actions.save') }).click();
  });
  expect(fetch).toHaveBeenLastCalledWith(mode === 'create' ? '/api/users' : '/api/users/2', expect.objectContaining({
    body: expect.stringContaining('"canViewGlobalUsage":true'),
  }));
});
