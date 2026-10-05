import { CUSTOM_DEFAULT_FLAGS } from './defaults.ts';
import { createCustomProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const customProviderModule: ProviderModule = {
  create: createCustomProvider,
  defaultFlags: CUSTOM_DEFAULT_FLAGS,
};

export {
  assertCustomUpstreamRecord,
  customManagementUrl,
  type CustomIngressHeaderRule,
  type CustomModelsFetch,
  type CustomOperationalAction,
  type CustomUpstreamConfig,
  type CustomUsageProbe,
  type CustomUsageProbeWindow,
} from './config.ts';
export { fetchCustomModels, type CustomModelsResponse, type CustomRawModel } from './fetch-models.ts';
export { customFetchManagement } from './fetch.ts';
export { executeCustomOperationalAction, type CustomActionResult } from './actions.ts';
export { fetchCustomUsageProbe, type CustomUsageProbeObservation, type CustomUsageWindowReading } from './usage-probe.ts';
export { projectCustomModels, projectCustomDiscoveredModels } from './provider.ts';
