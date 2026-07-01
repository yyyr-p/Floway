import { describe, expect, test } from 'vitest';

import { attributeCursorUsage, costPricingForBucket } from './cursor-usage-sync.ts';
import type { UsageRecord } from '../../../repo/types.ts';
import type { CursorUsageBucket } from '@floway-dev/provider-cursor';

const bucket = (over: Partial<CursorUsageBucket> = {}): CursorUsageBucket => ({
  model: 'gpt-5.2', hour: '2026-07-01T17', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cents: 0, ...over,
});

const row = (keyId: string, requests: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  keyId, model: 'gpt-5.2', upstream: 'up_c', modelKey: 'gpt-5.2', hour: '2026-07-01T17', tier: null, requests, tokens: {}, cost: null, ...over,
});

describe('attributeCursorUsage', () => {
  test('splits a bucket across keys proportional to request count', () => {
    const buckets = [bucket({ input: 400, output: 80, cacheRead: 4000, cents: 0.8 })];
    const rows = [row('key_a', 3), row('key_b', 1)];
    const out = attributeCursorUsage('up_c', buckets, rows);
    const a = out.find(r => r.keyId === 'key_a')!;
    const b = out.find(r => r.keyId === 'key_b')!;
    expect(a.tokens).toEqual({ input: 300, output: 60, input_cache_read: 3000, input_cache_write: 0 });
    expect(b.tokens).toEqual({ input: 100, output: 20, input_cache_read: 1000, input_cache_write: 0 });
    expect(a.requests).toBe(3); // request count preserved
    expect(b.requests).toBe(1);
  });

  test('drops IDE-only buckets (no matching Floway row) and model/hour mismatches', () => {
    const buckets = [
      bucket({ model: 'gpt-5.2', hour: '2026-07-01T17', input: 100, output: 10 }), // matches
      bucket({ model: 'claude-4.6-opus', hour: '2026-07-01T17', input: 999, output: 99 }), // no row for this model
      bucket({ model: 'gpt-5.2', hour: '2026-07-01T18', input: 999, output: 99 }), // no row for this hour
    ];
    const rows = [row('key_a', 1)];
    const out = attributeCursorUsage('up_c', buckets, rows);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ keyId: 'key_a', tokens: { input: 100, output: 10, input_cache_read: 0, input_cache_write: 0 } });
  });

  test('ignores rows from other upstreams', () => {
    const out = attributeCursorUsage('up_c', [bucket({ input: 100, output: 10 })], [row('key_x', 1, { upstream: 'up_other' })]);
    expect(out).toHaveLength(0);
  });

  test("attributed cost reproduces the bucket's real cents, split by request count", () => {
    const buckets = [bucket({ input: 100, output: 400, cents: 1.0 })]; // output is the largest dim
    const rows = [row('key_a', 3), row('key_b', 1)];
    const out = attributeCursorUsage('up_c', buckets, rows);
    // cost_usd for a record = Σ tokens[d] × pricing[d] / 1e6 (aggregate.recordCostUsd)
    const costUsd = (r: UsageRecord): number => {
      let t = 0;
      for (const [dim, price] of Object.entries(r.cost ?? {})) {
        if (dim === 'tiers') continue;
        t += (r.tokens[dim as keyof typeof r.tokens] ?? 0) * (price as number);
      }
      return t / 1e6;
    };
    expect(costUsd(out.find(r => r.keyId === 'key_a')!)).toBeCloseTo(0.0075, 6); // 0.75c
    expect(costUsd(out.find(r => r.keyId === 'key_b')!)).toBeCloseTo(0.0025, 6); // 0.25c
  });
});

describe('costPricingForBucket', () => {
  test('puts all cents on the largest-token dimension', () => {
    const p = costPricingForBucket(bucket({ input: 100, output: 400, cacheRead: 50, cents: 1.0 }))!;
    // output is largest -> only output priced; 400 tokens × price / 1e6 = $0.01
    expect(p.output).toBeCloseTo((1.0 / 100) * 1e6 / 400, 6);
    expect(p.input).toBe(0);
    expect(p.input_cache_read).toBe(0);
  });

  test('returns null when cents is zero (free/included request)', () => {
    expect(costPricingForBucket(bucket({ input: 100, output: 50, cents: 0 }))).toBeNull();
  });

  test('returns null when there are no tokens to attach cost to', () => {
    expect(costPricingForBucket(bucket({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cents: 5 }))).toBeNull();
  });
});
