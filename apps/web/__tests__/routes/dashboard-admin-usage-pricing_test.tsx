import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardAdminUsagePricing, { clientLoader } from '../../src/routes/dashboard-admin-usage-pricing';
import { useAuthStore } from '../../src/stores/auth-store';
import { stubLocalStorage } from '../local-storage-stub';
import { renderInApp } from '../render';
import type { ApplyResult, BackfillPlan, InspectionResult } from '@floway-dev/gateway/usage-pricing-backfill';

stubLocalStorage();

afterEach(() => {
  useAuthStore.getState().clear();
  vi.unstubAllGlobals();
});

const inspection: InspectionResult = {
  schemaVersion: 1,
  kind: 'usage-pricing-inspection',
  database: { kind: 'runtime', target: 'test database', stable: true },
  enabledUpstreams: [{ id: 'upstream-1', provider: 'custom', name: 'Primary' }],
  nullPriceSlices: [{
    upstream: 'upstream-1', model: 'public-model', modelKey: 'wire-model', pricingSelector: '{}',
    metric: 'input_tokens', rows: 2, firstHour: '2026-10-04T00', lastHour: '2026-10-04T01',
  }],
};

const plan: BackfillPlan = {
  schemaVersion: 2,
  kind: 'usage-pricing-backfill-plan',
  planId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  createdAt: '2026-10-05T00:00:00.000Z',
  database: inspection.database,
  intent: {
    upstream: 'upstream-1', model: 'public-model', modelKey: 'wire-model',
    startHour: '2026-10-04T00', endHour: '2026-10-04T02', timezone: 'Asia/Singapore',
    metrics: ['input_tokens'], mode: 'fill',
  },
  pricing: { status: 'priced', source: 'upstream configuration', digest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  evidence: { pricedSiblingExists: false },
  guards: {
    upstreamConfigDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    guardModelsCache: false,
  },
  snapshot: [{ pricingSelector: '{}', metric: 'input_tokens', unitPrice: null, rows: 2, representativeQuantity: '100' }],
  operations: [{
    pricingSelector: '{}', metric: 'input_tokens', proposedUnitPrice: '0.000001', expectedRows: 2,
    representative: { quantity: '100', realizedCost: '0.0001' },
  }],
  skipped: [],
  blockers: [],
  summary: { selectedRows: 2, rowsToUpdate: 2, remainingNullRows: 0 },
};

const applied: ApplyResult = {
  schemaVersion: 1,
  kind: 'usage-pricing-backfill-result',
  planId: plan.planId,
  database: plan.database,
  rowsUpdated: 2,
  operations: [{ ...plan.operations[0]!, remainingNullRows: 0 }],
  summary: { remainingNullRows: 0, remainingNullRowsByMetric: {} },
};

describe('who can inspect historical usage pricing', () => {
  it('redirects an operator before calling the admin API', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'operator-session', user: { id: 2, username: 'operator', isAdmin: false, canViewGlobalUsage: false, upstreamIds: null, upstreamModelAccess: [] } });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    const thrown = await clientLoader().then(() => null, (caught: unknown) => caught);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get('location')).toBe('/dashboard/services/api-keys');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('how a historical usage price plan is confirmed', () => {
  it('posts the displayed plan only after its exact ID is entered, then shows server verification', async () => {
    const user = { id: 1, username: 'admin', isAdmin: true, canViewGlobalUsage: true, upstreamIds: null, upstreamModelAccess: [] };
    useAuthStore.getState().primeFromLogin({ token: 'admin-session', user });
    const applyBodies: Array<{ plan: BackfillPlan; confirmationPlanId: string }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path.endsWith('/plan')) return Response.json(plan);
      if (path.endsWith('/apply')) {
        applyBodies.push(JSON.parse(String(init?.body)) as { plan: BackfillPlan; confirmationPlanId: string });
        return Response.json(applied);
      }
      if (path.endsWith('/inspect')) return Response.json(inspection);
      return Response.json({ error: `Unexpected request: ${path}` }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);

    await act(async () => { renderInApp(<DashboardAdminUsagePricing loaderData={{ inspection, error: null }} />); });
    fireEvent.change(screen.getByLabelText('Public model'), { target: { value: 'public-model' } });
    fireEvent.change(screen.getByLabelText('Wire model key'), { target: { value: 'wire-model' } });
    fireEvent.change(screen.getByLabelText('Start hour (inclusive, UTC)'), { target: { value: '2026-10-04T00' } });
    fireEvent.change(screen.getByLabelText('End hour (exclusive, UTC)'), { target: { value: '2026-10-04T02' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Input tokens' }));

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Build exact plan' })); });
    expect(await screen.findByText(plan.planId)).toBeTruthy();
    expect(screen.getByText('0.000001')).toBeTruthy();
    const applyButton = screen.getByRole('button', { name: 'Apply confirmed plan' }) as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    expect(applyBodies).toHaveLength(0);

    fireEvent.change(screen.getByLabelText('Confirm this exact plan ID'), { target: { value: plan.planId } });
    expect(applyButton.disabled).toBe(false);
    await act(async () => { fireEvent.click(applyButton); });
    await waitFor(() => expect(applyBodies).toHaveLength(1));
    expect(applyBodies[0]).toEqual({ plan, confirmationPlanId: plan.planId });
    expect(await screen.findByText('Verified 2 updated rows; 0 NULL-price rows remain in the selected scope.')).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('discards a plan response when the selected scope changes while it is pending', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, canViewGlobalUsage: true, upstreamIds: null, upstreamModelAccess: [] } });
    let resolvePlan: ((response: Response) => void) | undefined;
    const pendingPlan = new Promise<Response>(resolve => { resolvePlan = resolve; });
    const fetch = vi.fn(async () => await pendingPlan);
    vi.stubGlobal('fetch', fetch);

    await act(async () => { renderInApp(<DashboardAdminUsagePricing loaderData={{ inspection, error: null }} />); });
    fireEvent.change(screen.getByLabelText('Public model'), { target: { value: 'model-a' } });
    fireEvent.change(screen.getByLabelText('Wire model key'), { target: { value: 'wire-model' } });
    fireEvent.change(screen.getByLabelText('Start hour (inclusive, UTC)'), { target: { value: '2026-10-04T00' } });
    fireEvent.change(screen.getByLabelText('End hour (exclusive, UTC)'), { target: { value: '2026-10-04T02' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Input tokens' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build exact plan' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Public model'), { target: { value: 'model-b' } });
    await act(async () => {
      resolvePlan!(Response.json(plan));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect((screen.getByLabelText('Public model') as HTMLInputElement).value).toBe('model-b');
    expect(screen.queryByText(plan.planId)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Apply confirmed plan' })).toBeNull();
  });

  it('keeps the reviewed scope fixed until its apply result is verified', async () => {
    useAuthStore.getState().primeFromLogin({ token: 'admin-session', user: { id: 1, username: 'admin', isAdmin: true, canViewGlobalUsage: true, upstreamIds: null, upstreamModelAccess: [] } });
    let resolveApply: ((response: Response) => void) | undefined;
    const pendingApply = new Promise<Response>(resolve => { resolveApply = resolve; });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      if (path.endsWith('/plan')) return Response.json(plan);
      if (path.endsWith('/apply')) return await pendingApply;
      if (path.endsWith('/inspect')) return Response.json(inspection);
      return Response.json({ error: `Unexpected request: ${path}` }, { status: 404 });
    });
    vi.stubGlobal('fetch', fetch);

    await act(async () => { renderInApp(<DashboardAdminUsagePricing loaderData={{ inspection, error: null }} />); });
    fireEvent.change(screen.getByLabelText('Public model'), { target: { value: 'model-a' } });
    fireEvent.change(screen.getByLabelText('Wire model key'), { target: { value: 'wire-model' } });
    fireEvent.change(screen.getByLabelText('Start hour (inclusive, UTC)'), { target: { value: '2026-10-04T00' } });
    fireEvent.change(screen.getByLabelText('End hour (exclusive, UTC)'), { target: { value: '2026-10-04T02' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Input tokens' }));
    fireEvent.click(screen.getByRole('button', { name: 'Build exact plan' }));
    await screen.findByText(plan.planId);
    fireEvent.change(screen.getByLabelText('Confirm this exact plan ID'), { target: { value: plan.planId } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply confirmed plan' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    const modelField = screen.getByLabelText('Public model') as HTMLInputElement;
    const buildButton = screen.getByRole('button', { name: 'Build exact plan' }) as HTMLButtonElement;
    const selectSliceButton = screen.getByRole('button', { name: 'Use range' }) as HTMLButtonElement;
    expect(modelField.disabled).toBe(true);
    expect(buildButton.disabled).toBe(true);
    expect(selectSliceButton.disabled).toBe(true);

    fireEvent.change(modelField, { target: { value: 'model-b' } });
    fireEvent.click(selectSliceButton);
    fireEvent.click(buildButton);
    expect(modelField.value).toBe('model-a');
    expect(fetch).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveApply!(Response.json(applied));
      await new Promise(resolve => setTimeout(resolve, 0));
    });

    expect(modelField.value).toBe('model-a');
    expect(await screen.findByText('Verified 2 updated rows; 0 NULL-price rows remain in the selected scope.')).toBeTruthy();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  });
});
