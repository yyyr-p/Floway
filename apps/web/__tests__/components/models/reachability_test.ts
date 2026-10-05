import { describe, expect, it } from 'vitest';

import { effectiveUpstreams } from '../../../src/components/models/badges';
import { indexCatalog } from '../../../src/components/models/catalog-index';
import { effectiveUpstreamCap, isModelReachable, reachableModels } from '../../../src/components/models/reachability';
import { aliasModel, catalogModel } from '../../api/model-fixture';

describe('model reachability', () => {
  it('intersects API-key and owner upstream caps', () => {
    expect(effectiveUpstreamCap(['u1', 'u2'], ['u2', 'u3'])).toEqual(['u2']);
    expect(effectiveUpstreamCap(null, ['u1'])).toEqual(['u1']);
    expect(effectiveUpstreamCap(null, null)).toBeNull();
  });

  it('resolves alias targets through the effective cap', () => {
    const real = catalogModel('real', { upstreams: ['u1'] });
    const alias = aliasModel('alias', [real.id]);
    const catalog = indexCatalog([real, alias]);
    expect(isModelReachable(alias, catalog, ['u1'])).toBe(true);
    expect(isModelReachable(alias, catalog, ['u2'])).toBe(false);
  });

  it('resolves a same-id alias against the unaliased target catalog', () => {
    const target = catalogModel('gpt-6-luna', { upstreams: ['upstream-a', 'upstream-b'] });
    const alias = aliasModel('gpt-6-luna', ['gpt-6-luna']);

    expect(reachableModels([alias], ['upstream-b'], undefined, [target])).toEqual([alias]);
    expect(reachableModels([alias], ['upstream-c'], undefined, [target])).toEqual([]);
  });

  it('keeps only the catalog entries an alias or an upstream binding can reach', () => {
    const catalog = [
      catalogModel('allowed', { upstreams: ['u1'] }),
      catalogModel('key-denied', { upstreams: ['u2'] }),
      catalogModel('user-denied', { upstreams: ['u3'] }),
      aliasModel('alias-allowed', ['allowed', 'user-denied']),
      aliasModel('alias-denied', ['user-denied']),
      aliasModel('alias-missing', ['missing']),
    ];

    expect(reachableModels(catalog, effectiveUpstreamCap(['u1', 'u2', 'u3'], ['u1', 'u2']))
      .map(entry => entry.id))
      .toEqual(['allowed', 'key-denied', 'alias-allowed']);
    expect(reachableModels(catalog, [])).toEqual([]);
  });

  it('intersects user and key model rules against each upstream source model ID', () => {
    const first = {
      ...catalogModel('shared', { upstreams: ['u1'] }),
      upstreams: [{ id: 'u1', name: 'u1', modelId: 'source-a', kind: 'custom' as const, hue: 210, logoUrl: null }],
    };
    const second = {
      ...catalogModel('shared', { upstreams: ['u2'] }),
      upstreams: [{ id: 'u2', name: 'u2', modelId: 'source-b', kind: 'custom' as const, hue: 210, logoUrl: null }],
    };
    const shared = { ...first, upstreams: [...first.upstreams, ...second.upstreams] };
    const catalog = [shared];
    const userRules = [{ upstreamId: 'u1', mode: 'deny' as const, modelIds: ['source-a'] }];
    const keyRules = [
      { upstreamId: 'u1', mode: 'allow' as const, modelIds: ['source-a'] },
      { upstreamId: 'u2', mode: 'allow' as const, modelIds: ['source-b'] },
    ];

    expect(reachableModels(catalog, null, undefined, catalog, [...userRules, ...keyRules])).toEqual([shared]);
    expect(effectiveUpstreams(shared, indexCatalog(catalog), null, [...userRules, ...keyRules]).map(binding => binding.id))
      .toEqual(['u2']);
    expect(reachableModels(catalog, ['u1'], undefined, catalog, [
      ...userRules,
      { upstreamId: 'u1', mode: 'allow', modelIds: ['source-a'] },
    ])).toEqual([]);
  });

  it('keeps prefix-projected IDs separate from source IDs and applies policy after alias resolution', () => {
    const target = {
      ...catalogModel('team/public-id', { upstreams: ['u1'] }),
      upstreams: [{ id: 'u1', name: 'u1', modelId: 'provider-id', kind: 'custom' as const, hue: 210, logoUrl: null }],
    };
    const alias = aliasModel('friendly-name', [target.id]);
    const catalog = [target, alias];
    const index = indexCatalog(catalog);

    expect(isModelReachable(target, index, null, [
      { upstreamId: 'u1', mode: 'allow', modelIds: ['provider-id'] },
    ])).toBe(true);
    expect(isModelReachable(target, index, null, [
      { upstreamId: 'u1', mode: 'allow', modelIds: ['team/public-id'] },
    ])).toBe(false);
    expect(reachableModels(catalog, null, undefined, catalog, [
      { upstreamId: 'u1', mode: 'deny', modelIds: ['provider-id'] },
    ]).map(model => model.id)).toEqual([]);
  });

  it('narrows by the caller predicate without regard to endpoint surface', () => {
    const openaiResponsesOnly = catalogModel('responses-only', { upstreams: ['a'], endpoints: { openaiResponses: {} } });
    const alias = aliasModel('alias', ['responses-only'], { endpoints: { openaiResponses: {} } });
    const chatOnly = catalogModel('chat-only', { upstreams: ['a'], endpoints: { openaiChatCompletions: {} } });
    const embedding = catalogModel('embedding', { upstreams: ['a'], kind: 'embedding', endpoints: { openaiEmbeddings: {} } });

    expect(reachableModels([openaiResponsesOnly, alias, chatOnly, embedding], ['a'], model => model.kind === 'chat')
      .map(entry => entry.id))
      .toEqual(['responses-only', 'alias', 'chat-only']);
  });
});
