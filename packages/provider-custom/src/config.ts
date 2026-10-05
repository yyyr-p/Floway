// Configurable custom upstream — any third-party provider that serves one or
// more supported generation, embedding, image, or rerank protocols under a
// single base URL with a static credential. `authStyle` decides the credential header:
//   - 'bearer'    -> Authorization: Bearer <key>     (OpenAI, OpenRouter, ...)
//   - 'anthropic' -> x-api-key: <key> + anthropic-version: 2023-06-01
//                                                    (api.anthropic.com)
//   - 'none'      -> no auth header (local or internal upstreams that
//                                                    accept anonymous requests)
//
// The base URL is stored without an API prefix and joined to the selected
// protocol's path. Generation-family path overrides remain upstream-wide;
// rerank chooses its dialect and optional path on each model because no
// vendor-neutral rerank path exists.
//
// Custom upstreams surface models from two sources, merged at the data
// plane: a manual list of per-model entries
// (`config.models`) that pin metadata/pricing locally, and an optional
// live fetch of the upstream `/models` (`config.modelsFetch`). The `/models`
// path is part of the fetch toggle (`modelsFetch.endpoint`), not a generic
// path override, because it only matters when fetching is enabled.

import { customIngressHeaderNameIssue, isCustomIngressHeaderValue } from './ingress-header-rules.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { UpstreamModelConfig, UpstreamRecord } from '@floway-dev/provider';
import { endpointsField, modelsField, validateUpstreamPath } from '@floway-dev/provider';

export type CustomAuthStyle = 'bearer' | 'anthropic' | 'none';

// Logical endpoints the admin may override. Sub-paths (the messages
// count-tokens endpoint, the responses compact endpoint) and the catalog
// (`/models` — owned by modelsFetch.endpoint) are intentionally absent:
// they derive their URL from a parent override or a separate field. Each
// key is the default path fragment, so the upstream path is `/v1` + the key
// unless overridden — the lookup table is the key itself. Kept
// package-internal because outside callers reach the upstream through
// the typed `customFetchXxx` transports, not by naming an endpoint key.
const CUSTOM_PATH_OVERRIDE_KEYS = [
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/embeddings',
  '/alpha/search',
  '/images/generations',
  '/images/edits',
  '/audio/transcriptions',
] as const;

export type CustomPathOverrideKey = typeof CUSTOM_PATH_OVERRIDE_KEYS[number];

export interface CustomModelsFetch {
  enabled: boolean;
  endpoint?: string;
}

export interface CustomUsageProbeWindow {
  id: string;
  label: string;
  used: string;
  limit: string;
  resetAt?: string;
}

export interface CustomUsageProbe {
  path: string;
  windows: CustomUsageProbeWindow[];
}

export interface CustomOperationalAction {
  id: string;
  label: string;
  path: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: Record<string, unknown>;
}

// One rule per value the operator wants this upstream to receive under a
// header name. `value: null` passes the client's own value through, so it
// contributes a value only when the client sent the header. Any other value —
// the empty string included — is this upstream's own value and is contributed
// on every request.
//
// A name may carry several rules, and the upstream receives their values in
// rule order: a passthrough rule beside a configured one appends the
// configured value to what the client sent, and several configured rules send
// several values. A name carries at most one passthrough rule, because the
// client's values enter the request once. A name with no rule at all reaches
// no upstream: it is not admitted, and nothing here writes it.
//
// How several values reach the wire is the runtime's choice, and the two
// disagree: workerd keeps them as a list and emits one field line each, while
// undici concatenates on append and emits a single combined line. RFC 9110
// makes those the same field value for a list-typed name, so rules are
// expressed as values and the representation is left to the runtime.
// https://github.com/cloudflare/workerd/blob/5165b467ef2a5df54768cb5f18f33b2916e58fa7/src/workerd/api/headers.c%2B%2B#L398-L440
// https://github.com/nodejs/undici/blob/v8.3.0/lib/web/fetch/headers.js#L236-L258
// https://www.rfc-editor.org/rfc/rfc9110.html#section-5.3
export interface CustomIngressHeaderRule {
  key: string;
  value: string | null;
}

// Fields shared by every auth style. The discriminated branches below add
// `apiKey` only on the styles that actually send one, so consumers cannot
// reach for `config.apiKey` on a 'none' upstream.
interface CustomUpstreamConfigBase {
  baseUrl: string;
  endpoints: ModelEndpoints;
  pathOverrides?: Partial<Record<CustomPathOverrideKey, string>>;
  ingressHeadersRules: CustomIngressHeaderRule[];
  modelsFetch: CustomModelsFetch;
  models: UpstreamModelConfig[];
  usageProbe?: CustomUsageProbe;
  actions?: CustomOperationalAction[];
}

export type CustomUpstreamConfig =
  | (CustomUpstreamConfigBase & { authStyle: 'none' })
  | (CustomUpstreamConfigBase & { authStyle: 'bearer' | 'anthropic'; apiKey: string });

export type CustomUpstreamRecord = UpstreamRecord & {
  kind: 'custom';
  config: CustomUpstreamConfig;
};

const AUTH_STYLES: ReadonlySet<CustomAuthStyle> = new Set<CustomAuthStyle>(['bearer', 'anthropic', 'none']);

const authStyleField = (value: unknown): CustomAuthStyle => {
  if (typeof value !== 'string' || !AUTH_STYLES.has(value as CustomAuthStyle)) {
    throw new Error('Malformed custom upstream config: authStyle must be "bearer", "anthropic", or "none"');
  }
  return value as CustomAuthStyle;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const ingressHeadersRulesField = (value: unknown): CustomIngressHeaderRule[] => {
  if (!Array.isArray(value)) throw new Error('Malformed custom upstream config: ingressHeadersRules must be an array');
  const passthroughKeys = new Set<string>();
  return value.map((raw, index) => {
    if (!isRecord(raw) || Object.keys(raw).some(key => key !== 'key' && key !== 'value')) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}] must contain only key and value`);
    }
    if (typeof raw.key !== 'string') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key must be a valid HTTP header name`);
    }
    const key = raw.key.trim().toLowerCase();
    const nameIssue = customIngressHeaderNameIssue(key);
    if (nameIssue === 'invalid') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key must be a valid HTTP header name`);
    }
    if (nameIssue === 'anthropic-messages-owned') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key ${key} is owned by the Anthropic Messages protocol`);
    }
    if (nameIssue === 'transport-owned') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].key ${key} is owned by the HTTP transport`);
    }
    if (raw.value !== null && typeof raw.value !== 'string') {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].value must be a string or null`);
    }
    if (raw.value === null) {
      if (passthroughKeys.has(key)) {
        throw new Error(`Malformed custom upstream config: ingressHeadersRules passes ${key} through more than once`);
      }
      passthroughKeys.add(key);
      return { key, value: null };
    }
    if (!isCustomIngressHeaderValue(raw.value)) {
      throw new Error(`Malformed custom upstream config: ingressHeadersRules[${index}].value is not a valid HTTP header value`);
    }
    const headers = new Headers();
    headers.set(key, raw.value);
    return { key, value: headers.get(key) as string };
  });
};

const nonEmptyStringField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Malformed custom upstream config: ${field} must be a non-empty string`);
  return value;
};

const baseUrlField = (value: unknown): string => {
  const baseUrl = nonEmptyStringField(value, 'baseUrl').trim();
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('invalid protocol');
    }
  } catch {
    throw new Error('Malformed custom upstream config: baseUrl must be an http(s) URL');
  }
  return baseUrl;
};

const PATH_OVERRIDE_KEYS: ReadonlySet<string> = new Set(CUSTOM_PATH_OVERRIDE_KEYS);

const pathOverridesField = (value: unknown): CustomUpstreamConfigBase['pathOverrides'] => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: pathOverrides must be an object');

  const pathOverrides: NonNullable<CustomUpstreamConfigBase['pathOverrides']> = {};
  for (const [key, path] of Object.entries(value)) {
    if (!PATH_OVERRIDE_KEYS.has(key)) {
      throw new Error(`Malformed custom upstream config: unsupported pathOverrides key ${key}`);
    }
    const validPath = validateUpstreamPath(path, `pathOverrides.${key}`);
    if (!validPath.ok) throw new Error(`Malformed custom upstream config: ${validPath.error}`);
    pathOverrides[key as CustomPathOverrideKey] = validPath.value;
  }
  return pathOverrides;
};

// The /models fetch toggle. Absent defaults to enabled: existing upstreams
// fetched their model list before this toggle existed, and the migration
// backfills `{ enabled: true }`. `endpoint` is the optional `/models` path
// override; the migration writes `endpoint: null` where there was no
// override, so null/empty must parse cleanly as "no override".
const modelsFetchField = (value: unknown): CustomModelsFetch => {
  if (value === undefined) return { enabled: true };
  if (!isRecord(value)) throw new Error('Malformed custom upstream config: modelsFetch must be an object');
  if (typeof value.enabled !== 'boolean') throw new Error('Malformed custom upstream config: modelsFetch.enabled must be a boolean');

  if (value.endpoint === undefined || value.endpoint === null || value.endpoint === '') {
    return { enabled: value.enabled };
  }
  const validPath = validateUpstreamPath(value.endpoint, 'modelsFetch.endpoint');
  if (!validPath.ok) throw new Error(`Malformed custom upstream config: ${validPath.error}`);
  return { enabled: value.enabled, endpoint: validPath.value };
};

const managementPathField = (value: unknown, field: string): string => {
  if (typeof value !== 'string') throw new Error(`Malformed custom upstream config: ${field} must be a path`);
  const path = value.trim();
  if (
    path.length === 0 || path.length > 256 || !path.startsWith('/') || path.startsWith('//')
    || path.includes('//') || path.includes('\\') || /[?#%\u0000-\u0020\u007f]/.test(path)
    || path.split('/').some(segment => segment === '.' || segment === '..')
  ) {
    throw new Error(`Malformed custom upstream config: ${field} must be a same-origin absolute path without query or fragment`);
  }
  return path;
};

export const customManagementUrl = (config: CustomUpstreamConfig, rawPath: string): string => {
  const path = managementPathField(rawPath, 'management path');
  const base = new URL(config.baseUrl);
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    throw new Error('Malformed custom upstream config: management requests require a baseUrl without credentials, query, or fragment');
  }
  return `${config.baseUrl.replace(/\/+$/, '')}${path}`;
};

const actionIdField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value)) {
    throw new Error(`Malformed custom upstream config: ${field} must be a stable ASCII identifier`);
  }
  return value;
};

const actionLabelField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 80) {
    throw new Error(`Malformed custom upstream config: ${field} must be 1 to 80 characters`);
  }
  return value.trim();
};

const jsonPointerField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length < 2 || value.length > 512 || !value.startsWith('/')) {
    throw new Error(`Malformed custom upstream config: ${field} must be a JSON Pointer`);
  }
  if (/(~(?![01]))/.test(value)) throw new Error(`Malformed custom upstream config: ${field} contains an invalid JSON Pointer escape`);
  if (value.split('/').some(segment => ['__proto__', 'prototype', 'constructor'].includes(segment.replaceAll('~1', '/').replaceAll('~0', '~')))) {
    throw new Error(`Malformed custom upstream config: ${field} contains a forbidden property`);
  }
  return value;
};

const usageProbeField = (value: unknown): CustomUsageProbe => {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'path' && key !== 'windows')) {
    throw new Error('Malformed custom upstream config: usageProbe must contain only path and windows');
  }
  if (!Array.isArray(value.windows) || value.windows.length === 0 || value.windows.length > 8) {
    throw new Error('Malformed custom upstream config: usageProbe.windows must contain 1 to 8 windows');
  }
  const ids = new Set<string>();
  const windows = value.windows.map((raw, index): CustomUsageProbeWindow => {
    const field = `usageProbe.windows[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).some(key => !['id', 'label', 'used', 'limit', 'resetAt'].includes(key))) {
      throw new Error(`Malformed custom upstream config: ${field} has unsupported fields`);
    }
    const id = actionIdField(raw.id, `${field}.id`);
    if (ids.has(id)) throw new Error(`Malformed custom upstream config: ${field}.id must be unique`);
    ids.add(id);
    if (typeof raw.label !== 'string' || raw.label.trim().length === 0 || raw.label.trim().length > 80) {
      throw new Error(`Malformed custom upstream config: ${field}.label must be 1 to 80 characters`);
    }
    return {
      id,
      label: raw.label.trim(),
      used: jsonPointerField(raw.used, `${field}.used`),
      limit: jsonPointerField(raw.limit, `${field}.limit`),
      ...(raw.resetAt !== undefined ? { resetAt: jsonPointerField(raw.resetAt, `${field}.resetAt`) } : {}),
    };
  });
  return { path: managementPathField(value.path, 'usageProbe.path'), windows };
};

const actionsField = (value: unknown): CustomOperationalAction[] => {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('Malformed custom upstream config: actions must be an array with at most 8 entries');
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const field = `actions[${index}]`;
    if (!isRecord(raw) || Object.keys(raw).some(key => !['id', 'label', 'path', 'method', 'body'].includes(key))) {
      throw new Error(`Malformed custom upstream config: ${field} has unsupported fields`);
    }
    const id = actionIdField(raw.id, `${field}.id`);
    if (ids.has(id)) throw new Error(`Malformed custom upstream config: ${field}.id must be unique`);
    ids.add(id);
    if (raw.method !== 'POST' && raw.method !== 'PUT' && raw.method !== 'PATCH' && raw.method !== 'DELETE') {
      throw new Error(`Malformed custom upstream config: ${field}.method must be POST, PUT, PATCH, or DELETE`);
    }
    let body: Record<string, unknown> | undefined;
    if (raw.body !== undefined) {
      if (!isRecord(raw.body)) throw new Error(`Malformed custom upstream config: ${field}.body must be a JSON object`);
      let serialized: string;
      try {
        serialized = JSON.stringify(raw.body);
      } catch {
        throw new Error(`Malformed custom upstream config: ${field}.body must be JSON serializable`);
      }
      if (serialized.length > 4096) throw new Error(`Malformed custom upstream config: ${field}.body must not exceed 4096 characters`);
      body = structuredClone(raw.body);
    }
    return {
      id,
      label: actionLabelField(raw.label, `${field}.label`),
      path: managementPathField(raw.path, `${field}.path`),
      method: raw.method,
      ...(body !== undefined ? { body } : {}),
    };
  });
};

export const assertCustomUpstreamRecord = (record: UpstreamRecord): CustomUpstreamRecord => {
  if (record.kind !== 'custom') throw new Error(`Expected custom upstream record, got ${record.kind}`);
  if (!isRecord(record.config)) throw new Error('Malformed custom upstream config: config must be an object');

  const raw = record.config;
  const authStyle = authStyleField(raw.authStyle);
  const base = {
    baseUrl: baseUrlField(raw.baseUrl),
    endpoints: endpointsField(raw.endpoints, 'custom upstream config: endpoints', { allowEmpty: true }),
    ...(raw.pathOverrides !== undefined ? { pathOverrides: pathOverridesField(raw.pathOverrides) } : {}),
    ingressHeadersRules: ingressHeadersRulesField(raw.ingressHeadersRules),
    modelsFetch: modelsFetchField(raw.modelsFetch),
    models: modelsField(raw.models ?? [], 'custom'),
    ...(raw.usageProbe !== undefined ? { usageProbe: usageProbeField(raw.usageProbe) } : {}),
    ...(raw.actions !== undefined ? { actions: actionsField(raw.actions) } : {}),
  };

  if (authStyle === 'none') {
    // Reject dead fields: a stored 'none' row must not carry a stale apiKey
    // from an earlier auth style. mergeConfigPatch enforces this on PATCH
    // and the migration leaves no such rows, so any presence here signals
    // bad input.
    if (raw.apiKey !== undefined) {
      throw new Error('Malformed custom upstream config: apiKey must not be present when authStyle is "none"');
    }
    return { ...record, kind: 'custom', config: { ...base, authStyle } };
  }

  const apiKey = nonEmptyStringField(raw.apiKey, 'apiKey');
  return { ...record, kind: 'custom', config: { ...base, authStyle, apiKey } };
};
