import { DeleteRegular, SaveRegular } from '@fluentui/react-icons';
import { useCallback, useMemo, useState } from 'react';

import type { Route } from './+types/dashboard-admin-usage-limits';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import type { UsageLimitsSnapshot } from '../api/types';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Dropdown } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS, TWO_COLUMN_FORM_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const { Button, Field, Input, Option, Text } = fluentComponents;
type UsageLimitRow = UsageLimitsSnapshot['limits'][number];
type PrincipalType = 'user' | 'key';
type UsageWindow = 'hour' | 'day' | 'month';

const loadLimits = async (): Promise<UsageLimitsSnapshot> => {
  const result = await callApi(() => api.api['usage-limits'].$get());
  if (result.error) throw new Error(result.error.message);
  return result.data;
};

export async function clientLoader(): Promise<UsageLimitsSnapshot> {
  await requireDashboardAdmin();
  return await loadLimits();
}

export default function DashboardAdminUsageLimits({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [data, setData] = useState(loaderData);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [principalType, setPrincipalType] = useState<PrincipalType>('key');
  const [principalId, setPrincipalId] = useState('');
  const [window, setWindow] = useState<UsageWindow>('day');
  const [maxTokens, setMaxTokens] = useState('');
  const [maxCostUsd, setMaxCostUsd] = useState('');

  const principals = principalType === 'user' ? data.users : data.keys;
  const selectedPrincipal = principals.some(item => String(item.id) === principalId)
    ? principalId
    : String(principals[0]?.id ?? '');
  const sortedLimits = useMemo(() => [...data.limits].sort((a, b) =>
    a.principalType.localeCompare(b.principalType)
    || String(a.principalId).localeCompare(String(b.principalId))
    || a.window.localeCompare(b.window)), [data.limits]);

  const refresh = useCallback(async () => {
    try {
      setData(await loadLimits());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const save = useCallback(async () => {
    setError(null);
    if (selectedPrincipal === '') {
      setError(t('dashboard.usageLimits.noPrincipal'));
      return;
    }
    const parsedTokens = maxTokens.trim() === '' ? null : Number(maxTokens);
    const parsedCost = maxCostUsd.trim() === '' ? null : maxCostUsd.trim();
    if (parsedTokens === null && parsedCost === null) {
      setError(t('dashboard.usageLimits.oneLimitRequired'));
      return;
    }
    if (parsedTokens !== null && (!Number.isSafeInteger(parsedTokens) || parsedTokens < 0)) {
      setError(t('dashboard.usageLimits.invalidTokens'));
      return;
    }
    setSaving(true);
    const toast = toasts.start(t('dashboard.usageLimits.savePending'));
    const result = await callApi(() => api.api['usage-limits'].$put({
      json: {
        principalType,
        principalId: principalType === 'user' ? Number(selectedPrincipal) : selectedPrincipal,
        window,
        maxTokens: parsedTokens,
        maxCostUsd: parsedCost,
      },
    }));
    setSaving(false);
    if (result.error) {
      toast.settle();
      setError(result.error.message);
      return;
    }
    toast.succeed(t('dashboard.usageLimits.saveSuccess'));
    setMaxTokens('');
    setMaxCostUsd('');
    await refresh();
  }, [maxCostUsd, maxTokens, principalType, refresh, selectedPrincipal, toasts, t, window]);

  const remove = async (limit: UsageLimitRow) => {
    const id = `${limit.principalType}:${limit.principalId}:${limit.window}`;
    setDeleting(id);
    setError(null);
    const toast = toasts.start(t('dashboard.usageLimits.removePending'));
    const result = await callApi(() => api.api['usage-limits'][':principalType'][':principalId'][':window'].$delete({
      param: {
        principalType: limit.principalType,
        principalId: String(limit.principalId),
        window: limit.window,
      },
    }));
    setDeleting(null);
    if (result.error) {
      toast.settle();
      setError(result.error.message);
      return;
    }
    toast.succeed(t('dashboard.usageLimits.removeSuccess'));
    await refresh();
  };

  const principalName = (limit: UsageLimitRow): string => limit.principalType === 'user'
    ? data.users.find(user => user.id === limit.principalId)?.username ?? String(limit.principalId)
    : data.keys.find(key => key.id === limit.principalId)?.name ?? String(limit.principalId);

  return <section className="dashboard-page max-w-[960px]">
    <DashboardPageHeader
      description={t('dashboard.usageLimits.description')}
      title={t('dashboard.usageLimits.title')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}

    <Panel>
      <div className={PANEL_STACK_CLASS}>
        <div className={TWO_COLUMN_FORM_CLASS}>
          <Field label={t('dashboard.usageLimits.principalType')}>
            <Dropdown
              onOptionSelect={(_, option) => {
                if (option.optionValue === 'user' || option.optionValue === 'key') {
                  setPrincipalType(option.optionValue);
                  setPrincipalId('');
                }
              }}
              selectedOptions={[principalType]}
              value={t(`dashboard.usageLimits.${principalType}`)}
            >
              <Option text={t('dashboard.usageLimits.user')} value="user">{t('dashboard.usageLimits.user')}</Option>
              <Option text={t('dashboard.usageLimits.key')} value="key">{t('dashboard.usageLimits.key')}</Option>
            </Dropdown>
          </Field>
          <Field label={t('dashboard.usageLimits.principal')}>
            <Dropdown
              disabled={principals.length === 0}
              onOptionSelect={(_, option) => option.optionValue && setPrincipalId(option.optionValue)}
              selectedOptions={selectedPrincipal === '' ? [] : [selectedPrincipal]}
              value={principalType === 'user'
                ? data.users.find(user => String(user.id) === selectedPrincipal)?.username ?? ''
                : data.keys.find(key => key.id === selectedPrincipal)?.name ?? ''}
            >
              {principalType === 'user'
                ? data.users.map(user => <Option key={user.id} text={user.username} value={String(user.id)}>{user.username}</Option>)
                : data.keys.map(key => <Option key={key.id} text={key.name} value={key.id}>{key.name}</Option>)}
            </Dropdown>
          </Field>
          <Field label={t('dashboard.usageLimits.window')}>
            <Dropdown
              onOptionSelect={(_, option) => {
                if (option.optionValue === 'hour' || option.optionValue === 'day' || option.optionValue === 'month') setWindow(option.optionValue);
              }}
              selectedOptions={[window]}
              value={t(`dashboard.usageLimits.${window}`)}
            >
              {(['hour', 'day', 'month'] as const).map(value => <Option key={value} text={t(`dashboard.usageLimits.${value}`)} value={value}>{t(`dashboard.usageLimits.${value}`)}</Option>)}
            </Dropdown>
          </Field>
          <Field label={t('dashboard.usageLimits.maxTokens')}>
            <Input
              min={0}
              onChange={(_, value) => setMaxTokens(value.value)}
              type="number"
              value={maxTokens}
            />
          </Field>
          <Field label={t('dashboard.usageLimits.maxCostUsd')}>
            <Input
              min={0}
              onChange={(_, value) => setMaxCostUsd(value.value)}
              step="0.000001"
              type="number"
              value={maxCostUsd}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button appearance="primary" disabled={saving || principals.length === 0} icon={<SaveRegular />} onClick={() => void save()}>
            {t('dashboard.usageLimits.save')}
          </Button>
        </div>
      </div>
    </Panel>

    <section className="grid gap-3" aria-label={t('dashboard.usageLimits.currentUsage')}>
      {sortedLimits.length === 0
        ? <EmptyStateLine>{t('dashboard.usageLimits.empty')}</EmptyStateLine>
        : sortedLimits.map(limit => <UsageLimitRowView
            key={`${limit.principalType}:${limit.principalId}:${limit.window}`}
            deleting={deleting === `${limit.principalType}:${limit.principalId}:${limit.window}`}
            limit={limit}
            name={principalName(limit)}
            onRemove={() => void remove(limit)}
          />)}
    </section>
  </section>;
}

function UsageLimitRowView({ limit, name, deleting, onRemove }: {
  limit: UsageLimitRow;
  name: string;
  deleting: boolean;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const windowLabel = t(`dashboard.usageLimits.${limit.window}`);
  const principalLabel = t(`dashboard.usageLimits.${limit.principalType}`);
  const tokenUsage = limit.maxTokens === null
    ? t('dashboard.usageLimits.tokensUnlimited', { used: limit.usedTokens })
    : t('dashboard.usageLimits.tokens', { used: limit.usedTokens, limit: limit.maxTokens });
  const costUsage = limit.usedCostUsd === null
    ? t('dashboard.usageLimits.unpriced')
    : limit.maxCostUsd === null
      ? t('dashboard.usageLimits.costUnlimited', { used: limit.usedCostUsd })
      : t('dashboard.usageLimits.cost', { used: limit.usedCostUsd, limit: limit.maxCostUsd });

  return <div className="flex min-w-0 items-start justify-between gap-4 border-b border-fui-stroke2 py-3">
    <div className="grid min-w-0 gap-1">
      <Text weight="semibold">{principalLabel}: {name} · {windowLabel}</Text>
      <Text size={200} className="text-fui-fg2">{t('dashboard.usageLimits.currentUsage')}</Text>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <Text size={200}>{tokenUsage}</Text>
        <Text size={200}>{costUsage}</Text>
      </div>
    </div>
    <Button
      appearance="subtle"
      aria-label={`${t('dashboard.usageLimits.remove')}: ${name}`}
      disabled={deleting}
      icon={<DeleteRegular />}
      onClick={onRemove}
      title={t('dashboard.usageLimits.remove')}
    />
  </div>;
}
