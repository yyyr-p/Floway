// Codex-internal `/models` shape assembled for the shared catalog handler.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Pipeline: codex publishes a versioned catalog per release (see catalog.ts);
// the shared listing pipeline contributes real chat models and visible,
// caller-reachable chat aliases. We call `synthesizeCatalogEntry(model, base?)`
// with the segment-matched client catalog entry as `base` (or `undefined`
// when no catalog entry matches), then retain Codex's own wire shape.

import { resolveCodexCatalog, type CatalogModel, type CodexCatalog, type CodexCatalogCapabilities, type CodexServiceTier } from './catalog.ts';
import { synthesizeCatalogEntry } from './synthesize.ts';
import type { ModelsRefreshScheduler } from '../../execution/models-refresh.ts';
import type { UpstreamModelAccessRule } from '../../repo/model-access.ts';
import type { ModelAliasesRepo } from '../../repo/types.ts';
import { loadListedModels } from '../models/load.ts';
import type { AddressableIdEntry } from '../shared/listing/addressable.ts';
import type { InternalModel } from '@floway-dev/provider';
import { codexModelContextWindow } from '@floway-dev/provider-codex';

// Pure transformation: client catalog + addressable entries →
// codex-shaped catalog (drops unlisted alternates and non-chat kinds).
// Extracted so tests can drive the mapping logic without standing up the
// addressable-enumeration pipeline.
export const assembleCodexCatalog = (
  catalog: CodexCatalog,
  addressable: readonly AddressableIdEntry[],
  capabilities: CodexCatalogCapabilities = {},
  listedModels: readonly InternalModel[] = addressable
    .filter(entry => entry.unlisted === undefined)
    .map(entry => entry.model),
): CodexCatalog => {
  const catalogBySlug = new Map<string, CatalogModel>();
  for (const model of catalog.models) catalogBySlug.set(model.slug.toLowerCase(), model);
  const catalogServiceTiers: CodexServiceTier[] = catalog.models.flatMap(model => model.service_tiers ?? []);

  // Match against the client catalog by walking segments from the trailing leaf back
  // toward the prefix, so a publicId like `openrouter/gpt-5.5/gpt-5.4`
  // binds against `gpt-5.4` rather than the earlier `gpt-5.5` segment that
  // happens to collide with a catalog slug. Split on both `/` (model-prefix
  // segments) and `:` (OpenRouter-style `:variant` suffixes) — a variant
  // tag on the leaf falls through the walk without accidentally binding.
  const matchCatalog = (publicId: string): CatalogModel | undefined => {
    const segments = publicId.toLowerCase().split(/[/:]/);
    for (let i = segments.length - 1; i >= 0; i--) {
      const hit = catalogBySlug.get(segments[i]);
      if (hit !== undefined) return hit;
    }
    return undefined;
  };

  const addressableById = new Map(addressable.map(entry => [entry.id, entry] as const));
  const models: CatalogModel[] = [];
  for (const model of listedModels) {
    if (model.kind !== 'chat') continue;
    // Limits follow the registry's first-provider metadata policy. Only that
    // provider can supply Codex's private default; a same-named model from a
    // different provider must use its own advertised input budget.
    const sourceEntry = model.aliasedFrom === undefined ? addressableById.get(model.id) : undefined;
    const primaryUpstream = sourceEntry?.upstreams[0];
    let codexContextWindow;
    if (primaryUpstream?.kind === 'codex') {
      const providerModel = model.providerModels?.[primaryUpstream.upstreamId];
      if (providerModel === undefined) throw new Error(`Codex catalog model ${model.id} has no primary provider model`);
      codexContextWindow = codexModelContextWindow(providerModel);
    }
    models.push(synthesizeCatalogEntry(model, matchCatalog(model.id), capabilities, catalogServiceTiers, codexContextWindow));
  }
  return { models };
};

export const loadCodexCatalog = async (
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
  scheduleRefresh: ModelsRefreshScheduler,
  aliasRepo: ModelAliasesRepo,
  modelAccess: readonly UpstreamModelAccessRule[] = [],
): Promise<CodexCatalog> => {
  const [resolution, listed] = await Promise.all([
    resolveCodexCatalog(userAgent),
    loadListedModels(upstreamIds, scheduleRefresh, aliasRepo, modelAccess),
  ]);
  return assembleCodexCatalog(resolution.catalog, listed.addressable, resolution.capabilities, listed.models);
};
