import { ArrowClockwiseRegular, EditRegular } from '@fluentui/react-icons';
import { useState } from 'react';

import { actionEnvelope, upstreamEditorPath, type SubscriptionUpstreamRecord } from './data';
import { api, callApi } from '../../api/client';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { BackNavigationButton } from '../ui/back-navigation-button';
import { DashboardPageHeader } from '../ui/dashboard-page-header';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { StatusBadge } from '../ui/status-badge';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { ClaudeCodeAccountCard } from '../upstream-editor/claude-code-account-card';
import { CodexAccountCard } from '../upstream-editor/codex-account-card';
import { CopilotQuotaCard } from '../upstream-editor/copilot-quota-card';
import { OllamaUsageCard } from '../upstream-editor/ollama-usage-card';
import { shortAccountId } from '../upstreams/account-id';
import { findCredential as findClaudeCredential } from '../upstreams/claude-code-account';
import { codexRenewable, findCredential as findCodexCredential } from '../upstreams/codex-account';
import { ProviderIcon, providerLabel } from '../upstreams/provider-badge';

const { Button, Spinner, Text } = fluentComponents;

export function SubscriptionUpstreamDetailsPage({ initialRecord }: { initialRecord: SubscriptionUpstreamRecord }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [record, setRecord] = useState<SubscriptionUpstreamRecord>(initialRecord);
  const [refreshing, setRefreshing] = useState(false);
  const [probing, setProbing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const credentialRefreshAvailable = canRefreshCredential(record);
  const refreshCredential = async () => {
    if (!credentialRefreshAvailable || refreshing) return;
    setRefreshing(true);
    setActionError(null);
    const envelope = { record: actionEnvelope(record) };
    const result = record.kind === 'codex'
      ? await callApi(() => api.api.upstreams.codex.oauth.refresh.$post({ json: envelope }))
      : record.kind === 'claude-code'
        ? await callApi(() => api.api.upstreams['claude-code'].oauth.refresh.$post({ json: envelope }))
        : null;
    setRefreshing(false);
    if (result === null) return;
    if (result.error) {
      setActionError(t('dashboard.upstreamDetails.errors.refreshCredential'));
      return;
    }
    setRecord(current => ({ ...current, ...result.data.patch }) as SubscriptionUpstreamRecord);
  };

  const probeClaudeUsage = async () => {
    if (record.kind !== 'claude-code' || probing) return;
    setProbing(true);
    setActionError(null);
    const result = await callApi(() => api.api.upstreams['claude-code'].probe.$post({
      json: { record: actionEnvelope(record) },
    }));
    setProbing(false);
    if (result.error) {
      setActionError(t('dashboard.upstreamDetails.errors.refreshUsage'));
      return;
    }
    setRecord(current => ({ ...current, ...result.data.patch }) as SubscriptionUpstreamRecord);
  };

  const reloadStoredRecord = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setActionError(null);
    const result = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }));
    setRefreshing(false);
    if (result.error) {
      setActionError(t('dashboard.upstreamDetails.errors.reload'));
      return;
    }
    setRecord(result.data as SubscriptionUpstreamRecord);
  };

  return <div className="dashboard-page">
    <BackNavigationButton to="/dashboard/providers/upstreams">
      {t('dashboard.upstreamDetails.actions.back')}
    </BackNavigationButton>
    <DashboardPageHeader
      actions={<div className="flex items-center gap-2">
        <ResourceListActions
          appearance="subtle"
          onRefresh={() => void reloadStoredRecord()}
          refreshLabel={t('dashboard.upstreamDetails.actions.reload')}
          refreshing={refreshing}
        />
        {credentialRefreshAvailable && <Button
          appearance="subtle"
          disabledFocusable={refreshing}
          icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />}
          onClick={() => void refreshCredential()}
        >{t('dashboard.upstreamEditor.oauth.refresh')}</Button>}
        <TooltipIconButton
          icon={<EditRegular />}
          label={t('dashboard.upstreamDetails.actions.edit')}
          to={upstreamEditorPath(record)}
        />
      </div>}
      description={t(`dashboard.upstreams.providers.${record.kind}`)}
      title={record.name}
    />

    {actionError && <OutcomeMessageBar onDismiss={() => setActionError(null)}>{actionError}</OutcomeMessageBar>}

    <section className="grid gap-4 border-0 border-t border-solid border-fui-divider pt-4">
      <SectionHeader level={2} title={t('dashboard.upstreamDetails.sections.connection')} />
      <div className="flex items-start gap-3 min-w-0">
        <ProviderIcon kind={record.kind} className="h-8 w-8 shrink-0" />
        <div className="grid gap-1 min-w-0 flex-1">
          <Text block weight="semibold" truncate wrap={false}>{connectionTarget(record, t)}</Text>
          <Text size={200} className="text-fui-fg2">{identityLabel(record, t)}</Text>
        </div>
        <StatusBadge tone={record.enabled ? 'success' : 'neutral'}>
          {t(record.enabled ? 'dashboard.upstreamDetails.status.enabled' : 'dashboard.upstreamDetails.status.disabled')}
        </StatusBadge>
      </div>
      <dl className="grid grid-cols-[minmax(120px,0.3fr)_minmax(0,1fr)] gap-x-4 gap-y-2 m-0 max-[700px]:grid-cols-1">
        <Fact label={t('dashboard.upstreamDetails.fields.authentication')} value={authenticationLabel(record, t)} />
        {tokenExpiry(record, locale, t) && <Fact
          label={t('dashboard.upstreamDetails.fields.tokenExpires')}
          value={tokenExpiry(record, locale, t)!}
        />}
        {connectionEndpoint(record) && <Fact
          label={t('dashboard.upstreamDetails.fields.endpoint')}
          value={connectionEndpoint(record)!}
          monospace
        />}
      </dl>
    </section>

    <section className="grid gap-4 border-0 border-t border-solid border-fui-divider pt-4">
      <SectionHeader level={2} title={t('dashboard.upstreamDetails.sections.usage')} />
      {record.kind === 'codex' && <CodexAccountCard record={record} />}
      {record.kind === 'claude-code' && <ClaudeCodeAccountCard
        onRefreshQuota={() => void probeClaudeUsage()}
        probing={probing}
        record={record}
      />}
      {record.kind === 'copilot' && <CopilotQuotaCard record={record} />}
      {record.kind === 'ollama' && <OllamaUsageCard probeRecord={actionEnvelope(record)} record={record} />}
    </section>
  </div>;
}

function Fact({ label, monospace = false, value }: { label: string; monospace?: boolean; value: string }) {
  return <>
    <dt className="text-fui-fg3">{label}</dt>
    <dd className={`m-0 min-w-0 break-words ${monospace ? 'font-mono mono-size-xs' : ''}`}>{value}</dd>
  </>;
}

const canRefreshCredential = (record: SubscriptionUpstreamRecord): boolean => {
  if (record.kind === 'codex') {
    const lookup = findCodexCredential(record);
    return lookup.kind === 'present' && lookup.credential.state === 'active' && codexRenewable(lookup.credential);
  }
  if (record.kind === 'claude-code') {
    const lookup = findClaudeCredential(record);
    return lookup.kind === 'present' && lookup.credential.state === 'active' && lookup.credential.tokenKind === 'oauth';
  }
  return false;
};

const connectionTarget = (record: SubscriptionUpstreamRecord, t: ReturnType<typeof useTranslation>['t']): string => {
  if (record.kind === 'copilot') return safeEndpoint(record.state?.copilotToken?.baseUrl ?? record.config.githubHost);
  if (record.kind === 'ollama') return safeEndpoint(record.config.baseUrl);
  return t(`provider.${record.kind}`, providerLabel(record.kind));
};

const identityLabel = (record: SubscriptionUpstreamRecord, t: ReturnType<typeof useTranslation>['t']): string => {
  if (record.kind === 'codex') return record.config.accounts[0]?.email
    ?? (record.config.accounts[0]?.chatgptAccountId ? shortAccountId(record.config.accounts[0].chatgptAccountId) : t('dashboard.upstreamDetails.values.unknownAccount'));
  if (record.kind === 'claude-code') return record.config.accounts[0]?.email
    ?? shortAccountId(record.config.accounts[0]?.accountUuid ?? '');
  if (record.kind === 'copilot') return [record.config.user.name, record.config.user.login].filter(Boolean).join(' · ')
    || t('dashboard.upstreamDetails.values.unknownAccount');
  return record.state?.account?.name ?? record.state?.account?.email ?? t('dashboard.upstreamDetails.values.accountPending');
};

const authenticationLabel = (record: SubscriptionUpstreamRecord, t: ReturnType<typeof useTranslation>['t']): string => {
  if (record.kind === 'codex') {
    const lookup = findCodexCredential(record);
    if (lookup.kind !== 'present') return t('dashboard.upstreamDetails.status.missing');
    return t(`dashboard.upstreamDetails.credentials.${lookup.credential.state}`);
  }
  if (record.kind === 'claude-code') {
    const lookup = findClaudeCredential(record);
    if (lookup.kind !== 'present') return t('dashboard.upstreamDetails.status.missing');
    return t(`dashboard.upstreamDetails.credentials.${lookup.credential.state}`);
  }
  if (record.kind === 'copilot') return record.config.githubTokenSet || record.config.githubToken
    ? t('dashboard.upstreamDetails.status.configured')
    : t('dashboard.upstreamDetails.status.missing');
  return record.config.apiKeySet || record.config.apiKey
    ? t('dashboard.upstreamDetails.status.configured')
    : t('dashboard.upstreamDetails.status.missing');
};

const tokenExpiry = (
  record: SubscriptionUpstreamRecord,
  locale: string,
  t: ReturnType<typeof useTranslation>['t'],
): string | null => {
  let expiresAt: number | null = null;
  if (record.kind === 'codex') {
    const lookup = findCodexCredential(record);
    if (lookup.kind === 'present') expiresAt = lookup.credential.accessToken?.expiresAt ?? null;
  } else if (record.kind === 'claude-code') {
    const lookup = findClaudeCredential(record);
    if (lookup.kind === 'present') expiresAt = lookup.credential.accessToken?.expiresAt ?? null;
  } else if (record.kind === 'copilot') {
    const token = record.state?.copilotToken;
    if (token && 'expiresAt' in token) expiresAt = token.expiresAt;
  }
  if (expiresAt === null) return null;
  const iso = new Date(expiresAt).toISOString();
  return t('dashboard.upstreamDetails.values.expiresAt', { time: dateTime(iso, locale) });
};

const connectionEndpoint = (record: SubscriptionUpstreamRecord): string | null => {
  if (record.kind === 'copilot') return safeEndpoint(record.config.githubHost);
  if (record.kind === 'ollama') return safeEndpoint(record.config.baseUrl);
  return null;
};

const safeEndpoint = (value: string): string => {
  try {
    const url = new URL(value);
    const pathname = url.pathname === '/' ? '' : url.pathname;
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    return value;
  }
};
