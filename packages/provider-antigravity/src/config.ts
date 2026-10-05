// Antigravity upstream config — an OAuth subscription credential, so there
// is no operator-managed key material here at all. Everything identifying
// the account (email, project id) is derived at import time and persisted so
// the dashboard can render it without re-deriving from state.

// Operator-managed identity derived at OAuth import time: email from
// Google's userinfo endpoint, project id from the loadCodeAssist /
// onboardUser pairing, tier from the allowedTiers listing.
import type { UpstreamRecord } from '@floway-dev/provider';

// Operator-managed identity derived at OAuth import time: email from
// Google's userinfo endpoint, project id from the loadCodeAssist /
// onboardUser pairing, tier from the allowedTiers listing.
export interface AntigravityAccountIdentity {
  email: string | null;
  // The `cloudaicompanionProject` the upstream binds every data-plane call
  // to. Null until the onboarding step lands one; the access-token module
  // re-derives it lazily when null so a half-finished import self-heals on
  // the first request.
  projectId: string | null;
  // Raw tier id from loadCodeAssist (`currentTier.id` or the
  // `allowedTiers[].isDefault` entry); `free-tier` fallback. Not enum-cast —
  // Google adds tiers on its own schedule.
  tierId: string | null;
}

// v1 always carries exactly one account — typed as a 1-tuple like the other
// subscription providers. There is no operator-hand-edited section: config
// is written once per OAuth exchange and never patched by hand.
export interface AntigravityUpstreamConfig {
  accounts: [AntigravityAccountIdentity];
  // Optional egress override. Null/absent = the daily Cloud Code host; a
  // value is an operator-provided base for testing or a regional mirror.
  baseUrl?: string | null;
}

export type AntigravityUpstreamRecord = UpstreamRecord & {
  kind: 'antigravity';
  config: AntigravityUpstreamConfig;
};

function assertAntigravityAccountIdentity(value: unknown, where: string): asserts value is AntigravityAccountIdentity {
  const allowed = new Set(['email', 'projectId', 'tierId'] as const);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key as never)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (obj.email !== null && (typeof obj.email !== 'string' || obj.email === '')) {
    throw new TypeError(`${where}.email must be null or a non-empty string`);
  }
  if (obj.projectId !== null && (typeof obj.projectId !== 'string' || obj.projectId === '')) {
    throw new TypeError(`${where}.projectId must be null or a non-empty string`);
  }
  if (obj.tierId !== null && (typeof obj.tierId !== 'string' || obj.tierId === '')) {
    throw new TypeError(`${where}.tierId must be null or a non-empty string`);
  }
}

function assertAntigravityUpstreamConfig(value: unknown): asserts value is AntigravityUpstreamConfig {
  const allowed = new Set(['accounts', 'baseUrl'] as const);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('AntigravityUpstreamConfig must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key as never)) {
      throw new TypeError(`AntigravityUpstreamConfig has unexpected key '${key}'`);
    }
  }
  const accounts = obj.accounts;
  if (!Array.isArray(accounts)) {
    throw new TypeError('AntigravityUpstreamConfig.accounts must be an array');
  }
  if (accounts.length !== 1) {
    throw new TypeError(`AntigravityUpstreamConfig.accounts must hold exactly one account (got ${accounts.length})`);
  }
  assertAntigravityAccountIdentity(accounts[0], 'AntigravityUpstreamConfig.accounts[0]');
  if (obj.baseUrl !== null && obj.baseUrl !== undefined && (typeof obj.baseUrl !== 'string' || obj.baseUrl === '')) {
    throw new TypeError('AntigravityUpstreamConfig.baseUrl must be null, undefined, or a non-empty string');
  }
}

export function assertAntigravityUpstreamRecord(record: UpstreamRecord): asserts record is AntigravityUpstreamRecord {
  if (record.kind !== 'antigravity') {
    throw new TypeError(`Expected provider 'antigravity', got '${record.kind}'`);
  }
  assertAntigravityUpstreamConfig(record.config);
}
