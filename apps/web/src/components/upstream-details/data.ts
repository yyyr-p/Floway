import type { UpstreamRecord, UpstreamRecordEnvelope } from '../../api/types';

export type SubscriptionUpstreamRecord =
  | Extract<UpstreamRecord, { kind: 'codex' | 'claude-code' | 'copilot' }>
  | (Extract<UpstreamRecord, { kind: 'ollama' }> & { config: Extract<UpstreamRecord, { kind: 'ollama' }>['config'] & { cloudUsage: true } });

export const upstreamEditorPath = (record: UpstreamRecord): string =>
  `/dashboard/providers/upstreams/${encodeURIComponent(record.id)}`;

export const upstreamDetailsPath = (record: UpstreamRecord): string =>
  `${upstreamEditorPath(record)}/details`;

export const hasSubscriptionDetails = (record: UpstreamRecord): record is SubscriptionUpstreamRecord =>
  record.kind === 'codex'
  || record.kind === 'claude-code'
  || record.kind === 'copilot'
  || (record.kind === 'ollama' && record.config.cloudUsage === true);

export const actionEnvelope = (record: SubscriptionUpstreamRecord): UpstreamRecordEnvelope => ({
  id: record.id,
  kind: record.kind,
  config: record.config,
  state: record.state,
  proxy_fallback_list: record.proxy_fallback_list,
});
