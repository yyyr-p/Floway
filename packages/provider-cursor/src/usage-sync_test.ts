import { describe, expect, test } from 'vitest';

import { fetchCursorUsageBuckets, type FetchCursorUsageOptions } from './usage-sync.ts';
import type { Fetcher } from '@floway-dev/provider';

// Fetcher that returns `pages` in order for successive GetFilteredUsageEvents
// calls; anything else 404s.
const makeFetcher = (pages: unknown[]): { fetcher: Fetcher; usageCalls: () => number } => {
  let usageCall = 0;
  const fetcher: Fetcher = async url => {
    if (url.includes('GetFilteredUsageEvents')) {
      const body = pages[usageCall] ?? { usageEventsDisplay: [] };
      usageCall++;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { fetcher, usageCalls: () => usageCall };
};

const ev = (model: string, tsMs: number, input: number, output: number, cacheRead = 0, cents = 0) => ({
  timestamp: String(tsMs),
  model,
  isTokenBasedCall: true,
  tokenUsage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0, totalCents: cents },
});

const baseOpts = (fetcher: Fetcher): FetchCursorUsageOptions => ({
  accessToken: 'at.test',
  checksum: 'chk.test',
  fetcher,
  startMs: 0,
  endMs: 9_999_999_999_999,
  upstreamId: 'up_test',
});

const H17 = Date.UTC(2026, 6, 1, 17, 30);
const H18 = Date.UTC(2026, 6, 1, 18, 5);

describe('fetchCursorUsageBuckets', () => {
  test('aggregates events into (model, hour) buckets, summing tokens + cents', async () => {
    const { fetcher } = makeFetcher([
      { usageEventsDisplay: [ev('gpt-5.2', H17, 100, 20, 5000, 0.3), ev('gpt-5.2', H17 + 1000, 200, 30, 5000, 0.5), ev('kimi-k2.5', H18, 50, 10, 0, 0.1)] },
    ]);
    const buckets = await fetchCursorUsageBuckets(baseOpts(fetcher));
    expect(buckets).toHaveLength(2);
    const gpt = buckets.find(b => b.model === 'gpt-5.2')!;
    expect(gpt.hour).toBe('2026-07-01T17');
    expect(gpt).toMatchObject({ input: 300, output: 50, cacheRead: 10000 });
    expect(gpt.cents).toBeCloseTo(0.8, 6);
    const kimi = buckets.find(b => b.model === 'kimi-k2.5')!;
    expect(kimi).toMatchObject({ hour: '2026-07-01T18', input: 50, output: 10 });
  });

  test('pages until a short page and sums across pages', async () => {
    const full = Array.from({ length: 100 }, () => ev('gpt-5.2', H17, 1, 1));
    const { fetcher, usageCalls } = makeFetcher([
      { usageEventsDisplay: full },
      { usageEventsDisplay: [ev('gpt-5.2', H17, 1, 1)] },
    ]);
    const buckets = await fetchCursorUsageBuckets(baseOpts(fetcher));
    expect(usageCalls()).toBe(2); // page 1 was full (100) -> fetched page 2, which was short
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ input: 101, output: 101 });
  });

  test('skips events with no tokenUsage', async () => {
    const { fetcher } = makeFetcher([
      { usageEventsDisplay: [{ timestamp: String(H17), model: 'auto', tokenUsage: null }, ev('gpt-5.2', H17, 10, 5)] },
    ]);
    const buckets = await fetchCursorUsageBuckets(baseOpts(fetcher));
    expect(buckets).toHaveLength(1);
    expect(buckets[0]).toMatchObject({ model: 'gpt-5.2', input: 10 });
  });

  test('throws on a non-ok usage response', async () => {
    const fetcher: Fetcher = async () => new Response('nope', { status: 403 });
    await expect(fetchCursorUsageBuckets(baseOpts(fetcher))).rejects.toThrow(/GetFilteredUsageEvents 403/);
  });
});
