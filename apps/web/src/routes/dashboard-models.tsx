import { useCallback, useMemo, useState } from 'react';

import { useDashboardOutletContext } from './dashboard';
import { api, callApi } from '../api/client';
import type { ControlPlaneModel } from '../api/types';
import type { Route } from './+types/dashboard-models';
import { requireDashboardSession } from './guards';
import { indexCatalog } from '../components/models/catalog-index';
import { ModelCatalogTable } from '../components/models/catalog-table';
import { effectiveUpstreamCap, reachableModels } from '../components/models/reachability';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { ResourceListActions } from '../components/ui/resource-list';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const { Spinner } = fluentComponents;

interface LoaderData {
  error: { status: number } | null;
  models: ControlPlaneModel[] | null;
}

const loadModels = async (signal?: AbortSignal) =>
  await callApi(() => api.api.models.$get({ query: {} }, { init: { signal } }));

export async function clientLoader(): Promise<LoaderData> {
  requireDashboardSession();
  const result = await loadModels();
  return {
    models: result.data?.data ?? null,
    error: result.error ? { status: result.error.status } : null,
  };
}

export default function DashboardModels({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const [models, setModels] = useState(loaderData.models);
  const [error, setError] = useState(loaderData.error);
  const reload = useCallback(async (signal: AbortSignal) => {
    const result = await loadModels(signal);
    if (signal.aborted) return;
    if (result.error) {
      setError({ status: result.error.status });
      return;
    }
    setModels(result.data.data);
    setError(null);
  }, []);
  const { refresh, refreshing } = useRefresh(reload);
  const cap = useMemo(
    () => user.isAdmin ? null : effectiveUpstreamCap(null, user.upstreamIds),
    [user.isAdmin, user.upstreamIds],
  );
  const visibleModels = useMemo(
    () => models === null ? [] : reachableModels(models, cap),
    [cap, models],
  );
  const catalog = useMemo(() => indexCatalog(models), [models]);
  const errorMessage = error?.status === 0
    ? t('dashboard.modelsCatalog.errors.connection')
    : error === null ? null : t('dashboard.modelsCatalog.errors.http', { status: error.status });

  return <section className="dashboard-page min-w-0">
    <DashboardPageHeader
      actions={<ResourceListActions
        onRefresh={() => void refresh()}
        refreshLabel={t('dashboard.modelsCatalog.actions.refresh')}
        refreshing={refreshing}
      />}
      description={t('dashboard.pages.models')}
      title={t('dashboard.nav.models')}
    />
    {errorMessage !== null && models !== null && <OutcomeMessageBar intent="warning">{errorMessage}</OutcomeMessageBar>}
    {models === null
      ? <Panel>
          {errorMessage === null
            ? <Spinner label={t('dashboard.modelsCatalog.loading')} />
            : <EmptyStateLine>{errorMessage}</EmptyStateLine>}
        </Panel>
      : <ModelCatalogTable cap={cap} catalog={catalog} models={visibleModels} />}
  </section>;
}
