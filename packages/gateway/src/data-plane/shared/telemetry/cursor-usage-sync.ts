/**
 * Cursor account-level usage sync (approximate, hourly) — fallback only.
 *
 * The RunSSE stream now carries cursor's own per-request token accounting, so
 * the data plane records real tokens + notional cost for every cursor request
 * (see provider-cursor agent-translate finalize). This sync is the fallback
 * for the residual case where a request was counted but no token signal
 * arrived: it pulls the whole cursor ACCOUNT's real per-model usage from the
 * dashboard RPC and splits each (model, hour) bucket across the Floway API
 * keys whose rows still have zero tokens, by request count. It never touches a
 * row that already has real per-request tokens. This split is an
 * APPROXIMATION:
 *   - it includes usage that never went through Floway (the operator's own
 *     Cursor IDE / other clients on the same account);
 *   - it distributes by request count, not by each request's real tokens.
 * Floway telemetry is display/export only (no billing/quota), so this is
 * acceptable — surfaced with a disclaimer on the Cursor upstream settings panel.
 *
 * Only fully-COMPLETED hours are back-filled (strictly before the current UTC
 * hour): cursor records usage a few minutes late, and the current hour is still
 * accumulating request counts, so writing it mid-hour would race the data plane.
 */

import { createPerRequestFetcher } from '../../../dial/per-request.ts';
import { getRepo } from '../../../repo/index.ts';
import { startOfUtcHour } from '../../../repo/responses-payload.ts';
import type { UsageRecord } from '../../../repo/types.ts';
import { getEnvOptional } from '@floway-dev/platform';
import { type BillingDimension, type ModelPricing } from '@floway-dev/protocols/common';
import {
  assertCursorUpstreamState,
  ensureCursorAccessToken,
  fetchCursorUsageBuckets,
  generateCursorChecksum,
  mintCursorAccessToken,
  type CursorUsageBucket,
} from '@floway-dev/provider-cursor';

const SYNC_HOURS = 3; // back-fill the last N completed hours each run (idempotent)
const HOUR_MS = 60 * 60 * 1000;

const hourStr = (ms: number): string => new Date(ms).toISOString().slice(0, 13); // YYYY-MM-DDTHH

// Synthetic pricing so the usage row's derived cost equals cursor's real cents.
// Put the whole bucket's cents on the dimension with the most tokens and zero
// every other dimension (so unitPriceForDimension's input-fallback can't double
// charge). Same unit price applies to each key's proportional split. Returns
// null when there is no cents or no tokens to attach it to (cost then shows 0).
export const costPricingForBucket = (b: CursorUsageBucket): ModelPricing | null => {
  if (b.cents <= 0) return null;
  const dims: [BillingDimension, number][] = [
    ['output', b.output],
    ['input', b.input],
    ['input_cache_read', b.cacheRead],
    ['input_cache_write', b.cacheWrite],
  ];
  const [dim, tokens] = dims.reduce((best, cur) => (cur[1] > best[1] ? cur : best));
  if (tokens <= 0) return null;
  const pricing: ModelPricing = { input: 0, input_cache_read: 0, input_cache_write: 0, input_cache_write_1h: 0, input_image: 0, output: 0, output_image: 0 };
  pricing[dim] = (b.cents / 100) * 1e6 / tokens; // $ per million tokens s.t. tokens*price/1e6 == dollars
  return pricing;
};

/**
 * Pure attribution: split each account (model, hour) bucket across the Floway
 * usage rows (one per key) that made requests in it, proportional to request
 * count, returning the UsageRecords to write. Buckets with no matching Floway
 * row (IDE-only usage) are dropped. Model matched by exact id — cursor's
 * modelIntent equals the Floway model id for named models; a mismatch leaves
 * that bucket unattributed (treated as non-Floway usage).
 *
 * Rows that already carry real per-request tokens are left untouched: the
 * RunSSE stream now reports cursor's own token accounting per request (see
 * provider-cursor agent-translate finalize), so the data plane records real
 * tokens + notional cost directly. This account-level sync is only a fallback
 * for rows that got no per-request signal (a request counted, tokens still 0),
 * and it must never clobber the real numbers with the coarser account split.
 */
const hasRealTokens = (r: UsageRecord): boolean => Object.values(r.tokens).some(v => (v ?? 0) > 0);

export const attributeCursorUsage = (upstreamId: string, buckets: readonly CursorUsageBucket[], rows: readonly UsageRecord[]): UsageRecord[] => {
  const rowsByBucket = new Map<string, UsageRecord[]>();
  for (const r of rows) {
    if (r.upstream !== upstreamId) continue;
    if (hasRealTokens(r)) continue; // real per-request tokens already recorded — don't overwrite
    const k = `${r.model} ${r.hour}`;
    const list = rowsByBucket.get(k);
    if (list) list.push(r); else rowsByBucket.set(k, [r]);
  }

  const out: UsageRecord[] = [];
  for (const b of buckets) {
    const keyRows = rowsByBucket.get(`${b.model} ${b.hour}`);
    if (!keyRows) continue; // no Floway request in this (model, hour) — IDE-only, skip
    const totalReq = keyRows.reduce((s, r) => s + r.requests, 0);
    if (totalReq <= 0) continue;
    const cost = costPricingForBucket(b);
    for (const r of keyRows) {
      const frac = r.requests / totalReq;
      out.push({
        keyId: r.keyId,
        model: r.model,
        upstream: upstreamId,
        modelKey: r.modelKey,
        hour: r.hour,
        tier: null,
        requests: r.requests, // preserve the (final, past-hour) request count
        tokens: {
          input: Math.round(b.input * frac),
          output: Math.round(b.output * frac),
          input_cache_read: Math.round(b.cacheRead * frac),
          input_cache_write: Math.round(b.cacheWrite * frac),
        },
        cost,
      });
    }
  }
  return out;
};

const syncOneUpstream = async (
  upstreamId: string,
  state: unknown,
  fetcher: ReturnType<Awaited<ReturnType<typeof createPerRequestFetcher>>>,
  startMs: number,
  endMs: number,
): Promise<void> => {
  assertCursorUpstreamState(state);
  const account = state.accounts[0];
  if (account.state !== 'active') return;

  const persistRotation = async (newRefreshToken: string): Promise<void> => {
    const fresh = await getRepo().upstreams.getById(upstreamId);
    if (fresh?.provider !== 'cursor') return;
    assertCursorUpstreamState(fresh.state);
    const acc = fresh.state.accounts[0];
    await getRepo().upstreams.saveState(upstreamId, { accounts: [{ ...acc, refresh_token: newRefreshToken }] }, { expectedState: fresh.state });
  };

  const entry = await ensureCursorAccessToken(upstreamId, account.userId, refresh => mintCursorAccessToken(refresh, fetcher, persistRotation));
  const checksum = await generateCursorChecksum(entry.token);
  const buckets = await fetchCursorUsageBuckets({ accessToken: entry.token, checksum, fetcher, startMs, endMs, upstreamId });
  if (buckets.length === 0) return;

  const rows = await getRepo().usage.query({ start: hourStr(startMs), end: hourStr(endMs) });
  for (const record of attributeCursorUsage(upstreamId, buckets, rows)) {
    await getRepo().usage.set(record);
  }
};

/**
 * Sweep: for every enabled cursor upstream, back-fill the last few completed
 * hours of real account usage, proportionally attributed to Floway keys.
 * Per-upstream failures are isolated so one bad account doesn't block the rest.
 */
export const syncCursorUsage = async (): Promise<void> => {
  const upstreams = (await getRepo().upstreams.list()).filter(u => u.provider === 'cursor' && u.enabled);
  if (upstreams.length === 0) return;

  const colo = (getEnvOptional('RUNTIME_LOCATION', '') || 'LOCAL').toUpperCase();
  const fetcherFor = await createPerRequestFetcher(colo);

  const currentHourStart = startOfUtcHour(Date.now());
  const endMs = currentHourStart; // exclude the in-progress hour
  const startMs = currentHourStart - SYNC_HOURS * HOUR_MS;

  for (const upstream of upstreams) {
    try {
      await syncOneUpstream(upstream.id, upstream.state, fetcherFor(upstream.id), startMs, endMs);
    } catch (err) {
      console.error(`[scheduled] cursor.usageSync failed for upstream ${upstream.id}`, err);
    }
  }
};
