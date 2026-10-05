import type { CustomUpstreamConfig } from './config.ts';
import { customFetchManagement } from './fetch.ts';
import type { Fetcher } from '@floway-dev/provider';
import { identityWrapUpstreamCall } from '@floway-dev/provider';

export interface CustomActionResult {
  ok: boolean;
  status: number;
}

export const executeCustomOperationalAction = async (
  config: CustomUpstreamConfig,
  actionId: string,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<CustomActionResult> => {
  const action = config.actions?.find(candidate => candidate.id === actionId);
  if (action === undefined) throw new Error('Custom operational action is not configured');

  const headers = new Headers();
  const body = action.body === undefined ? undefined : JSON.stringify(action.body);
  if (body !== undefined) headers.set('content-type', 'application/json');
  const response = await customFetchManagement(
    config,
    action.path,
    {
      method: action.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'manual',
      signal,
    },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error(`Custom operational action refused redirect response ${response.status}`);
  }
  await response.body?.cancel();
  return { ok: response.ok, status: response.status };
};
