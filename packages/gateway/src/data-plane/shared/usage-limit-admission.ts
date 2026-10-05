import type { GatewayCtx } from './gateway-ctx.ts';
import { getRepo } from '../../repo/index.ts';
import type { DecimalString } from '@floway-dev/protocols/common';
import { providerModelOf, type ModelCandidate } from '@floway-dev/provider';

const compareDecimal = (left: string, right: string): number => {
  const [leftWhole, leftFraction = ''] = left.split('.');
  const [rightWhole, rightFraction = ''] = right.split('.');
  const scale = Math.max(leftFraction.length, rightFraction.length);
  const a = BigInt(leftWhole!) * 10n ** BigInt(scale) + BigInt(leftFraction.padEnd(scale, '0') || '0');
  const b = BigInt(rightWhole!) * 10n ** BigInt(scale) + BigInt(rightFraction.padEnd(scale, '0') || '0');
  return a < b ? -1 : a > b ? 1 : 0;
};

const highestConfiguredTokenPrice = (candidates: readonly ModelCandidate[]): DecimalString | null => {
  let maximum: DecimalString | null = null;
  for (const candidate of candidates) {
    const pricing = providerModelOf(candidate).pricing;
    for (const entry of pricing?.entries ?? []) {
      for (const price of Object.values(entry.rates)) {
        if (price !== undefined && (maximum === null || compareDecimal(price, maximum) > 0)) maximum = price;
      }
    }
  }
  return maximum;
};

export type UsageLimitAdmission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'tokens' | 'cost' | 'historical-cost-unpriced' }
  | { readonly ok: false; readonly reason: 'storage'; readonly error: unknown };

export const reserveUsageLimit = async (
  ctx: GatewayCtx,
  candidates: readonly ModelCandidate[],
): Promise<UsageLimitAdmission> => {
  let limits;
  try {
    limits = await getRepo().usageLimits.list();
  } catch (error) {
    console.error('Usage-limit policy lookup failed:', error);
    return { ok: false, reason: 'storage', error };
  }
  const applicable = limits.filter(limit =>
    (limit.principalType === 'key' && limit.principalId === ctx.apiKeyId)
    || (limit.principalType === 'user' && limit.principalId === ctx.apiKeyUserId));
  if (applicable.length === 0) return { ok: true };

  const id = crypto.randomUUID();
  const now = new Date();
  const maxUnitPriceUsd = applicable.some(limit => limit.maxCostUsd !== null)
    ? highestConfiguredTokenPrice(candidates)
    : null;
  let result;
  try {
    result = await getRepo().usageLimits.reserve({
      id,
      keyId: ctx.apiKeyId,
      userId: ctx.apiKeyUserId,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      inputTokens: ctx.estimatedInputTokens,
      outputTokens: ctx.requestedOutputTokenLimit,
      maxUnitPriceUsd,
    });
  } catch (error) {
    console.error('Usage-limit reservation failed:', error);
    return { ok: false, reason: 'storage', error };
  }
  if (!result.ok) return result;
  if (result.limited) ctx.usageLimitReservationId = id;
  return { ok: true };
};

export const usageLimitDenialMessage = (reason: 'tokens' | 'cost' | 'historical-cost-unpriced' | 'storage', error?: unknown): string => {
  switch (reason) {
  case 'tokens':
    return 'Usage limit exceeded for this API key or user.';
  case 'cost':
    return 'Usage cost limit cannot admit this request because no usable token price is configured, or the remaining budget is insufficient.';
  case 'historical-cost-unpriced':
    return 'Usage cost limit cannot admit this request because earlier usage has no recorded price.';
  case 'storage':
    return `Usage limit storage failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`;
  }
};
