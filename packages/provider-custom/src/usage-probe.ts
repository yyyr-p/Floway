import type { CustomUsageProbeWindow, CustomUpstreamConfig } from './config.ts';
import { customFetchManagement } from './fetch.ts';
import type { Fetcher } from '@floway-dev/provider';
import { identityWrapUpstreamCall } from '@floway-dev/provider';

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface CustomUsageWindowReading {
  id: string;
  label: string;
  used: number;
  limit: number;
  percent: number | null;
  resetAt: string | null;
}

export interface CustomUsageProbeObservation {
  fetchedAt: number;
  windows: CustomUsageWindowReading[];
}

const readBoundedBody = async (response: Response): Promise<string> => {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Custom usage probe response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pointerValue = (value: unknown, pointer: string): unknown => {
  let current = value;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      current = current[Number(key)];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
};

const nonNegativeNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.trim())
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Custom usage probe ${field} must resolve to a non-negative number`);
  return parsed;
};

const readWindow = (payload: unknown, window: CustomUsageProbeWindow): CustomUsageWindowReading => {
  const used = nonNegativeNumber(pointerValue(payload, window.used), `${window.id}.used`);
  const limit = nonNegativeNumber(pointerValue(payload, window.limit), `${window.id}.limit`);
  const rawResetAt = window.resetAt === undefined ? undefined : pointerValue(payload, window.resetAt);
  let resetAt: string | null = null;
  if (rawResetAt !== undefined && rawResetAt !== null) {
    if (typeof rawResetAt !== 'string' || !Number.isFinite(Date.parse(rawResetAt))) {
      throw new Error(`Custom usage probe ${window.id}.resetAt must resolve to a date string`);
    }
    resetAt = new Date(rawResetAt).toISOString();
  }
  return {
    id: window.id,
    label: window.label,
    used,
    limit,
    percent: limit === 0 ? null : Math.round((used / limit) * 100),
    resetAt,
  };
};

export const fetchCustomUsageProbe = async (
  config: CustomUpstreamConfig,
  fetcher: Fetcher,
  signal?: AbortSignal,
): Promise<CustomUsageProbeObservation> => {
  const probe = config.usageProbe;
  if (probe === undefined) throw new Error('Custom usage probe is not configured');
  const response = await customFetchManagement(
    config,
    probe.path,
    { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal },
    { fetcher, wrapUpstreamCall: identityWrapUpstreamCall },
  );
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error(`Custom usage probe refused redirect response ${response.status}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Custom usage probe returned HTTP ${response.status}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedBody(response));
  } catch (cause) {
    throw new Error('Custom usage probe response could not be read as bounded JSON', { cause });
  }
  if (!isRecord(payload)) throw new Error('Custom usage probe response must be a JSON object');
  return {
    fetchedAt: Date.now(),
    windows: probe.windows.map(window => readWindow(payload, window)),
  };
};
