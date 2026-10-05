export type UpstreamModelAccessMode = 'inherit' | 'allow' | 'deny';

export interface UpstreamModelAccessRule {
  upstreamId: string;
  mode: UpstreamModelAccessMode;
  modelIds: string[];
}

export const parseUpstreamModelAccess = (value: unknown, label: string): UpstreamModelAccessRule[] => {
  if (!Array.isArray(value)) throw new Error(`upstream_model_access is not an array for ${label}`);
  const upstreamIds = new Set<string>();
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`upstream_model_access[${index}] is not an object for ${label}`);
    }
    const rule = entry as Record<string, unknown>;
    if (typeof rule.upstreamId !== 'string' || rule.upstreamId.length === 0) {
      throw new Error(`upstream_model_access[${index}].upstreamId is invalid for ${label}`);
    }
    if (upstreamIds.has(rule.upstreamId)) {
      throw new Error(`upstream_model_access contains duplicate upstream ${rule.upstreamId} for ${label}`);
    }
    upstreamIds.add(rule.upstreamId);
    if (rule.mode !== 'inherit' && rule.mode !== 'allow' && rule.mode !== 'deny') {
      throw new Error(`upstream_model_access[${index}].mode is invalid for ${label}`);
    }
    if (!Array.isArray(rule.modelIds) || !rule.modelIds.every(id => typeof id === 'string' && id.length > 0)) {
      throw new Error(`upstream_model_access[${index}].modelIds is invalid for ${label}`);
    }
    if (new Set(rule.modelIds).size !== rule.modelIds.length) {
      throw new Error(`upstream_model_access[${index}].modelIds contains duplicates for ${label}`);
    }
    if (rule.mode === 'inherit' && rule.modelIds.length !== 0) {
      throw new Error(`upstream_model_access[${index}] inherit rule must not include modelIds for ${label}`);
    }
    return { upstreamId: rule.upstreamId, mode: rule.mode, modelIds: [...rule.modelIds] };
  });
};

export const isModelAllowedByUpstreamModelAccess = (
  rules: readonly UpstreamModelAccessRule[],
  upstreamId: string,
  modelId: string,
): boolean => {
  for (const rule of rules) {
    if (rule.upstreamId !== upstreamId) continue;
    if (rule.mode === 'allow' && !rule.modelIds.includes(modelId)) return false;
    if (rule.mode === 'deny' && rule.modelIds.includes(modelId)) return false;
  }
  return true;
};
