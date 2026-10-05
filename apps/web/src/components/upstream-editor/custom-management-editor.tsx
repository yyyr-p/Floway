import { PlugConnectedRegular } from '@fluentui/react-icons';
import { useCallback, useState } from 'react';
import { Controller, useFormContext, useFormState, useWatch } from 'react-hook-form';

import type { UpstreamEditorValues } from './data';
import { previewRecord } from './data';
import { EditorSection } from './section';
import { api, callApi } from '../../api/client';
import type { CustomUsageRefresh, UpstreamRecord, UpstreamRecordEnvelope } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime } from '../../lib/format-time';
import { clampPercent } from '../../lib/percent';
import { useLocale } from '../../lib/use-locale';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListActions } from '../ui/resource-list';
import { SectionHeader } from '../ui/section-header';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useRefresh } from '../ui/use-refresh';
const { Button, Field, ProgressBar, Text, Textarea } = fluentComponents;

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;
type CustomAction = NonNullable<CustomRecord['config']['actions']>[number];
type CustomEditorValues = Omit<UpstreamEditorValues, 'config'> & {
  config: CustomRecord['config'] & { usageProbeJson: string; actionsJson: string };
};

const usageProbeFromJson = (value: string): CustomRecord['config']['usageProbe'] | undefined => {
  if (value.trim() === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as CustomRecord['config']['usageProbe']
      : undefined;
  } catch {
    return undefined;
  }
};

export function CustomManagementEditor({ record }: { record: CustomRecord }) {
  const { t } = useTranslation();
  const { control, getValues, setValue } = useFormContext<CustomEditorValues>();
  const usageProbe = useWatch({ control, name: 'config.usageProbe' });
  const usageJson = useWatch({ control, name: 'config.usageProbeJson' }) ?? '';
  const actions = useWatch({ control, name: 'config.actions' }) ?? [];

  const setParsedConfig = (field: 'usageProbe' | 'actions', text: string) => {
    if (text.trim() === '') {
      setValue(`config.${field}`, undefined, { shouldDirty: true });
      return;
    }
    try {
      setValue(`config.${field}`, JSON.parse(text) as never, { shouldDirty: true });
    } catch {
      // The syntax issue remains on the visible JSON field until it parses.
    }
  };

  return <EditorSection level={3} title={t('dashboard.upstreamEditor.management.title')}>
    <div className="grid gap-3">
      <Controller control={control} name="config.usageProbeJson" render={({ field, fieldState }) => <Field
        label={t('dashboard.upstreamEditor.management.usageProbe')}
        validationMessage={fieldState.error?.message ? t(fieldState.error.message) : undefined}
        validationState={fieldState.error ? 'error' : undefined}
      >
        <Textarea
          className="font-mono"
          name={field.name}
          onBlur={field.onBlur}
          onChange={(_, data) => {
            field.onChange(data.value);
            setParsedConfig('usageProbe', data.value);
          }}
          placeholder={'{\n  "path": "/account/usage",\n  "windows": [{ "id": "week", "label": "Weekly", "used": "/usage/used", "limit": "/usage/limit", "resetAt": "/usage/reset_at" }]\n}'}
          ref={field.ref}
          rows={6}
          value={field.value ?? ''}
        />
      </Field>} />
      <Controller control={control} name="config.actionsJson" render={({ field, fieldState }) => <Field
        label={t('dashboard.upstreamEditor.management.actions')}
        validationMessage={fieldState.error?.message ? t(fieldState.error.message) : undefined}
        validationState={fieldState.error ? 'error' : undefined}
      >
        <Textarea
          className="font-mono"
          name={field.name}
          onBlur={field.onBlur}
          onChange={(_, data) => {
            field.onChange(data.value);
            setParsedConfig('actions', data.value);
          }}
          placeholder={'[{\n  "id": "reset",\n  "label": "Reset quota",\n  "path": "/account/reset",\n  "method": "POST",\n  "body": { "scope": "weekly" }\n}]'}
          ref={field.ref}
          rows={7}
          value={field.value ?? ''}
        />
      </Field>} />
    </div>
    {usageProbe !== undefined && <CustomUsageCard getValues={getValues} probeValid={usageProbeFromJson(usageJson) !== undefined} record={record} />}
    {actions.length > 0 && <CustomActionsCard actions={actions} record={record} />}
  </EditorSection>;
}

function CustomUsageCard({ getValues, probeValid, record }: {
  getValues: ReturnType<typeof useFormContext<CustomEditorValues>>['getValues'];
  probeValid: boolean;
  record: CustomRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [reading, setReading] = useState<CustomUsageRefresh['observation'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const probeRecord = previewRecord(record, getValues() as unknown as UpstreamEditorValues) as UpstreamRecordEnvelope;
  const { refresh: load, refreshing } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setError(null);
    const { data, error: failure } = await callApi(() => api.api.upstreams.custom.usage.$post(
      { json: { record: probeRecord } },
      { init: { signal } },
    ));
    if (signal.aborted) return;
    if (failure) setError(failure.message);
    else setReading(data.observation);
  }, [probeRecord]));

  return <section className="grid gap-3 border-0 border-t border-solid border-fui-divider pt-4">
    <SectionHeader level={3} title={t('dashboard.upstreamEditor.management.usageTitle')} actions={
      <ResourceListActions
        appearance="subtle"
        disabled={!probeValid}
        onRefresh={() => void load()}
        refreshLabel={t(reading ? 'dashboard.upstreamEditor.management.refresh' : 'dashboard.upstreamEditor.management.load')}
        refreshing={refreshing}
      />
    } />
    {reading?.windows.map(window => <div className="grid gap-1" key={window.id}>
      <div className="flex items-baseline justify-between gap-3">
        <Text size={300}>{window.label}</Text>
        <Text size={200} className="text-fui-fg2">
          {window.percent === null
            ? t('dashboard.upstreamEditor.management.noLimit', { used: new Intl.NumberFormat(locale).format(window.used) })
            : t('dashboard.upstreamEditor.management.used', {
                used: new Intl.NumberFormat(locale).format(window.used),
                limit: new Intl.NumberFormat(locale).format(window.limit),
                percent: Math.round(window.percent),
              })}
        </Text>
      </div>
      {window.percent !== null && <ProgressBar color="brand" max={100} thickness="large" value={clampPercent(window.percent) ?? undefined} />}
      {window.resetAt !== null && <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.management.resets', { time: dateTime(window.resetAt, locale) })}</Text>}
    </div>)}
    {reading && <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.management.observed', { time: dateTime(reading.fetchedAt, locale) })}</Text>}
    {!reading && !refreshing && <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.management.usageEmpty')}</Text>}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </section>;
}

function CustomActionsCard({ actions, record }: { actions: CustomAction[]; record: CustomRecord }) {
  const { t } = useTranslation();
  const dialog = useDialogInvocation<CustomAction>();
  const { isDirty } = useFormState();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; status: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = dialog.invocation?.value;

  const execute = async () => {
    if (selected === undefined || busy) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const { data, error: failure } = await callApi(() => api.api.upstreams.custom.actions.execute.$post({
        json: { upstreamId: record.id, actionId: selected.id, confirmed: true },
      }));
      if (failure) setError(t('dashboard.upstreamEditor.management.actionUnknown', { message: failure.message }));
      else setOutcome(data);
      dialog.close();
    } finally {
      setBusy(false);
    }
  };

  return <section className="grid gap-3 border-0 border-t border-solid border-fui-divider pt-4">
    <SectionHeader level={3} title={t('dashboard.upstreamEditor.management.actionsTitle')} />
    <div className="flex flex-wrap gap-2">
      {actions.map(action => <Button
        appearance="secondary"
        disabled={record.id === '' || isDirty || busy}
        icon={<PlugConnectedRegular />}
        key={action.id}
        onClick={() => {
          setError(null);
          setOutcome(null);
          dialog.open(action);
        }}
      >{action.label}</Button>)}
    </div>
    {(record.id === '' || isDirty) && <Text size={200} className="text-fui-fg3">{t('dashboard.upstreamEditor.management.saveFirst')}</Text>}
    {outcome && <OutcomeMessageBar intent={outcome.ok ? 'success' : 'warning'} onDismiss={() => setOutcome(null)}>
      {t(outcome.ok ? 'dashboard.upstreamEditor.management.actionSucceeded' : 'dashboard.upstreamEditor.management.actionFailed', { status: outcome.status })}
    </OutcomeMessageBar>}
    {error && <OutcomeMessageBar intent="warning" onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    <ConfirmDialog
      actionLabel={t('dashboard.upstreamEditor.management.actionConfirm')}
      actionIntent="danger"
      busy={busy}
      message={t('dashboard.upstreamEditor.management.actionConfirmMessage', { label: selected?.label ?? '' })}
      onConfirm={() => void execute()}
      onOpenChange={open => { if (!busy && !open) dialog.close(); }}
      open={dialog.isOpen}
      title={t('dashboard.upstreamEditor.management.actionConfirmTitle')}
    />
  </section>;
}
