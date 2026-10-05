import type { CatalogIndex } from './catalog-index';
import { indexCatalog } from './catalog-index';
import type { ControlPlaneModel } from '../../api/types';

export interface UpstreamModelAccessRule {
  upstreamId: string;
  mode: 'inherit' | 'allow' | 'deny';
  modelIds: string[];
}

export const isModelBindingReachable = (
  binding: ControlPlaneModel['upstreams'][number],
  cap: readonly string[] | null,
  modelAccess: readonly UpstreamModelAccessRule[],
): boolean => {
  if (cap !== null && !cap.includes(binding.id)) return false;
  return modelAccess.every(rule => rule.upstreamId !== binding.id
    || (rule.mode !== 'allow' || rule.modelIds.includes(binding.modelId))
      && (rule.mode !== 'deny' || !rule.modelIds.includes(binding.modelId)));
};

export const effectiveUpstreamCap = (
  keyUpstreamIds: readonly string[] | null,
  userUpstreamIds: readonly string[] | null,
): readonly string[] | null => {
  if (keyUpstreamIds === null && userUpstreamIds === null) return null;
  if (keyUpstreamIds === null) return userUpstreamIds;
  if (userUpstreamIds === null) return keyUpstreamIds;
  const userCap = new Set(userUpstreamIds);
  return keyUpstreamIds.filter(id => userCap.has(id));
};

const realModelReachable = (
  model: ControlPlaneModel,
  cap: readonly string[] | null,
  modelAccess: readonly UpstreamModelAccessRule[],
) => model.upstreams.some(upstream => isModelBindingReachable(upstream, cap, modelAccess));

export const reachableTargets = (
  alias: ControlPlaneModel,
  catalog: CatalogIndex,
  cap: readonly string[] | null,
  modelAccess: readonly UpstreamModelAccessRule[] = [],
): readonly ControlPlaneModel[] => {
  if (alias.aliasedFrom === undefined) return [];
  return alias.aliasedFrom.targets.flatMap(target => {
    const resolved = catalog.get(target.target_model_id);
    return resolved !== undefined && realModelReachable(resolved, cap, modelAccess) ? [resolved] : [];
  });
};

export const isModelReachable = (
  model: ControlPlaneModel,
  catalog: CatalogIndex,
  cap: readonly string[] | null,
  modelAccess: readonly UpstreamModelAccessRule[] = [],
): boolean => model.aliasedFrom === undefined
  ? realModelReachable(model, cap, modelAccess)
  : reachableTargets(model, catalog, cap, modelAccess).length > 0;

export const reachableModels = (
  catalog: readonly ControlPlaneModel[],
  cap: readonly string[] | null,
  accept: (model: ControlPlaneModel) => boolean = () => true,
  targetCatalog: readonly ControlPlaneModel[] = catalog,
  modelAccess: readonly UpstreamModelAccessRule[] = [],
): ControlPlaneModel[] => {
  const index = indexCatalog(targetCatalog);
  return catalog.filter(model => accept(model) && isModelReachable(model, index, cap, modelAccess));
};
