import { redirect } from 'react-router';

import { api, callApi } from '../api/client';
import type { Route } from './+types/dashboard-providers-upstreams-details';
import { requireDashboardAdmin } from './guards';
import { revalidateOnPathnameChange } from './revalidation';
import { hasSubscriptionDetails } from '../components/upstream-details/data';
import { SubscriptionUpstreamDetailsPage } from '../components/upstream-details/page';
import { dashboardWorkspaceHandle } from '../lib/dashboard-route-handle';

export const handle = dashboardWorkspaceHandle;

export async function clientLoader({ params }: Route.ClientLoaderArgs) {
  await requireDashboardAdmin();
  const result = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: params.id } }));
  if (result.error?.status === 404) throw redirect('/dashboard/providers/upstreams?missing=1');
  if (result.error) throw new Error('Unable to load upstream details', { cause: result.error });
  if (!hasSubscriptionDetails(result.data)) {
    throw redirect(`/dashboard/providers/upstreams/${encodeURIComponent(result.data.id)}`);
  }
  return { record: result.data };
}

export const shouldRevalidate = revalidateOnPathnameChange;

export default function DashboardProvidersUpstreamsDetails({ loaderData }: Route.ComponentProps) {
  return <SubscriptionUpstreamDetailsPage initialRecord={loaderData.record} />;
}
