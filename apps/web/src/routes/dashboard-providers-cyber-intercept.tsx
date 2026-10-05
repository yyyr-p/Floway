import { DeleteRegular, Shield24Regular } from '@fluentui/react-icons';
import type { InferResponseType } from 'hono/client';
import { useCallback, useMemo, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import { dateTime } from '../lib/format-time';
import { useLocale } from '../lib/use-locale';
import type { Route } from './+types/dashboard-providers-cyber-intercept';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import type { ControlPlaneModel, CyberInterceptAuditRecord, CyberInterceptSettings, UpstreamRecord } from '../api/types';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Dropdown, Input, LISTBOX_POSITIONING, Textarea } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { SectionHeader } from '../components/ui/section-header';
import { SettingsExpander, SettingsSwitch } from '../components/ui/settings-card';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { fluentComponents } from '../fluent';

const {
  Button,
  Field,
  Option,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
} = fluentComponents;

type PromptDefaults = InferResponseType<typeof api.api['cyber-intercept']['defaults']['$get'], 200>;

const AUDIT_PAGE_SIZE = 50;

interface LoaderData {
  settings: CyberInterceptSettings;
  promptDefaults: PromptDefaults;
  models: ControlPlaneModel[] | null;
  upstreams: UpstreamRecord[] | null;
  audit: CyberInterceptAuditRecord[] | null;
  auditError: string | null;
}

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  const [settingsResult, promptDefaultsResult, modelsResult, upstreamsResult, auditResult] = await Promise.all([
    callApi(() => api.api['cyber-intercept'].settings.$get()),
    callApi(() => api.api['cyber-intercept'].defaults.$get()),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
    callApi(() => api.api.upstreams.$get()),
    callApi(() => api.api['cyber-intercept']['audit-log'].$get({ query: { limit: String(AUDIT_PAGE_SIZE), offset: '0' } })),
  ]);
  if (settingsResult.error) throw new Error(settingsResult.error.message);
  if (promptDefaultsResult.error) throw new Error(promptDefaultsResult.error.message);
  return {
    settings: settingsResult.data,
    promptDefaults: promptDefaultsResult.data,
    models: modelsResult.data?.data ?? null,
    upstreams: upstreamsResult.data ?? null,
    audit: auditResult.data ?? null,
    auditError: auditResult.error?.message ?? null,
  };
}

const modelLabel = (model: ControlPlaneModel) => model.display_name ?? model.id;

// The payload-char cap shown next to the maxPayloadChars field when the
// operator has not set one — the estimate the gate itself derives from the
// judge model's declared context window. The floor mirrors the gate's
// FALLBACK_MAX_PAYLOAD_CHARS, and the fallback notice tells the operator the
// judge model declared no window. Constants mirror
// packages/gateway/src/data-plane/chat/shared/cyber-intercept/payload.ts and
// must move together with it.
const CHARS_PER_TOKEN_ESTIMATE = 4;
const PAYLOAD_CHAR_RESERVE = 8000;
const FALLBACK_MAX_PAYLOAD_CHARS = 32000;
const estimateMaxPayloadChars = (maxContextWindowTokens: number | null | undefined): number => {
  if (typeof maxContextWindowTokens !== 'number' || maxContextWindowTokens <= 0) return FALLBACK_MAX_PAYLOAD_CHARS;
  return Math.max(FALLBACK_MAX_PAYLOAD_CHARS, maxContextWindowTokens * CHARS_PER_TOKEN_ESTIMATE - PAYLOAD_CHAR_RESERVE);
};

const formatChars = (count: number): string => count.toLocaleString();

// Numeric fields round-trip through text inputs; a cleared or unparseable
// value falls back to null, whose meaning is field-specific (auto estimate /
// keep forever).
const parseIntOrReset = (raw: string): number | null => {
  const parsed = Number.parseInt(raw.replace(/[,\s]/g, ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export default function DashboardProvidersCyberIntercept({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [auditError, setAuditError] = useState(loaderData.auditError);
  const { models, upstreams } = loaderData;

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader
        description={t('dashboard.pages.cyberIntercept')}
        title={t('dashboard.cyberIntercept.heading')}
      />

      {auditError && <OutcomeMessageBar onDismiss={() => setAuditError(null)}>{auditError}</OutcomeMessageBar>}

      {models === null || upstreams === null
        ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel>
        : <CyberInterceptSettingsEditor
            judgeModels={models.filter(model => model.kind === 'chat')}
            promptDefaults={loaderData.promptDefaults}
            settings={loaderData.settings}
            upstreams={upstreams}
          />}

      {loaderData.audit !== null && <CyberInterceptAuditList initialAudit={loaderData.audit} locale={locale} />}
    </section>
  );
}

// Any chat model any enabled upstream serves can be the judge — the gate
// routes through the same catalog the data plane does, aliases included.
function CyberInterceptSettingsEditor({ judgeModels, promptDefaults, settings, upstreams }: {
  judgeModels: ControlPlaneModel[];
  promptDefaults: PromptDefaults;
  settings: CyberInterceptSettings;
  upstreams: UpstreamRecord[];
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [draft, setDraft] = useState<CyberInterceptSettings>(settings);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const eligibleJudgeModels = useMemo(
    () => judgeModels.filter(model => model.upstreams.some(binding => upstreams.some(u => u.id === binding.id && u.enabled))),
    [judgeModels, upstreams],
  );
  const selectedJudgeModel = eligibleJudgeModels.find(model => model.id === draft.judgeModelId);
  const unavailableJudgeModelId = draft.judgeModelId !== '' && !selectedJudgeModel ? draft.judgeModelId : null;
  const estimatedCap = estimateMaxPayloadChars(selectedJudgeModel?.limits.max_context_window_tokens);
  const windowMissing = selectedJudgeModel?.limits.max_context_window_tokens === undefined;
  const capIsEstimate = draft.maxPayloadChars === null;
  const promptsAtDefaults = draft.prefixPrompt === promptDefaults.prefixPrompt && draft.suffixPrompt === promptDefaults.suffixPrompt;

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    const handle = toasts.start(t('dashboard.cyberIntercept.toastSavePending'));
    const result = await callApi(() => api.api['cyber-intercept'].settings.$put({ json: draft }));
    if (result.error) {
      setSaving(false);
      handle.settle();
      setSaveError(result.error.message);
      return;
    }
    setSaving(false);
    handle.succeed(t('dashboard.cyberIntercept.toastSaveSuccess'));
  }, [draft, t, toasts]);

  const setField = <K extends keyof CyberInterceptSettings>(key: K, value: CyberInterceptSettings[K]) =>
    setDraft(current => ({ ...current, [key]: value }));

  return (
    <Panel className={PANEL_STACK_CLASS}>
      <SettingsExpander
        action={<SettingsSwitch
          checked={draft.enabled}
          label={t('dashboard.cyberIntercept.enableLabel')}
          onChange={checked => setField('enabled', checked)}
        />}
        defaultOpen={draft.enabled}
        description={t('dashboard.cyberIntercept.enableDescription')}
        header={t('dashboard.cyberIntercept.enableLabel')}
        icon={<Shield24Regular />}
        toggledOn={draft.enabled}
      >
        <div className="grid gap-3">
          <Field label={t('dashboard.cyberIntercept.judgeModel')}>
            <Dropdown
              className="!w-auto"
              listWidth="content"
              onOptionSelect={(_, data) => {
                if (data.optionValue) setField('judgeModelId', data.optionValue);
              }}
              positioning={{ ...LISTBOX_POSITIONING, align: 'start' }}
              selectedOptions={[draft.judgeModelId]}
              value={selectedJudgeModel
                ? modelLabel(selectedJudgeModel)
                : (unavailableJudgeModelId === null ? '' : t('dashboard.cyberIntercept.unavailableModel', { id: unavailableJudgeModelId }))}
            >
              {unavailableJudgeModelId !== null && (
                <Option disabled text={unavailableJudgeModelId} value={unavailableJudgeModelId}>
                  {t('dashboard.cyberIntercept.unavailableModel', { id: unavailableJudgeModelId })}
                </Option>
              )}
              {eligibleJudgeModels.map(model => (
                <Option key={model.id} text={modelLabel(model)} value={model.id}>
                  <span className="grid gap-0.5 min-w-0">
                    <span className="truncate">{modelLabel(model)}</span>
                    <Text block className="min-w-0" size={100} truncate wrap={false}>{model.id}</Text>
                  </span>
                </Option>
              ))}
            </Dropdown>
          </Field>
          {unavailableJudgeModelId !== null && (
            <Text size={200} className="text-fui-fg3">{t('dashboard.cyberIntercept.unavailableHint')}</Text>
          )}
        </div>
      </SettingsExpander>

      <SettingsExpander
        defaultOpen={draft.mode === 'fallback'}
        description={t('dashboard.cyberIntercept.modeDescription')}
        header={t('dashboard.cyberIntercept.modeLabel')}
        icon={<Shield24Regular />}
      >
        <div className="grid gap-3">
          <Field label={t('dashboard.cyberIntercept.modeField')}>
            <Dropdown
              className="!w-auto"
              listWidth="content"
              onOptionSelect={(_, data) => {
                if (data.optionValue === 'reject' || data.optionValue === 'fallback') setField('mode', data.optionValue);
              }}
              positioning={{ ...LISTBOX_POSITIONING, align: 'start' }}
              selectedOptions={[draft.mode]}
              value={t(`dashboard.cyberIntercept.mode.${draft.mode}`)}
            >
              <Option text={t('dashboard.cyberIntercept.mode.reject')} value="reject">{t('dashboard.cyberIntercept.mode.reject')}</Option>
              <Option text={t('dashboard.cyberIntercept.mode.fallback')} value="fallback">{t('dashboard.cyberIntercept.mode.fallback')}</Option>
            </Dropdown>
          </Field>
          <Text size={200} className="text-fui-fg3">
            {draft.mode === 'fallback'
              ? t('dashboard.cyberIntercept.modeFallbackHint')
              : t('dashboard.cyberIntercept.modeRejectHint')}
          </Text>
        </div>
      </SettingsExpander>

      <SettingsExpander
        defaultOpen={false}
        description={t('dashboard.cyberIntercept.payloadCapDescription')}
        header={t('dashboard.cyberIntercept.payloadCapLabel')}
        icon={<Shield24Regular />}
      >
        <div className="grid gap-3">
          {selectedJudgeModel && (windowMissing
            ? <Text size={200}>{t('dashboard.cyberIntercept.capFallbackNotice', { fallback: formatChars(FALLBACK_MAX_PAYLOAD_CHARS) })}</Text>
            : <Text size={200}>{t('dashboard.cyberIntercept.capEstimateNotice', {
                estimate: formatChars(estimatedCap),
                window: formatChars(selectedJudgeModel.limits.max_context_window_tokens!),
              })}</Text>)}
          <Field hint={capIsEstimate ? t('dashboard.cyberIntercept.capAutoHint', { value: formatChars(estimatedCap) }) : undefined} label={t('dashboard.cyberIntercept.capField')}>
            <Input
              inputMode="numeric"
              onChange={(_, data) => setField('maxPayloadChars', parseIntOrReset(data.value))}
              placeholder={formatChars(estimatedCap)}
              value={draft.maxPayloadChars === null ? '' : formatChars(draft.maxPayloadChars)}
            />
          </Field>
          <Text size={200} className="text-fui-fg3">{t('dashboard.cyberIntercept.capClearHint')}</Text>
        </div>
      </SettingsExpander>

      <SettingsExpander
        defaultOpen={false}
        description={t('dashboard.cyberIntercept.retainDescription')}
        header={t('dashboard.cyberIntercept.retainLabel')}
        icon={<Shield24Regular />}
      >
        <div className="grid gap-3">
          <Field hint={draft.auditLogRetentionSeconds === null ? t('dashboard.cyberIntercept.retainForever') : undefined} label={t('dashboard.cyberIntercept.retainField')}>
            <Input
              inputMode="numeric"
              onChange={(_, data) => setField('auditLogRetentionSeconds', parseIntOrReset(data.value))}
              placeholder={t('dashboard.cyberIntercept.retainForeverPlaceholder')}
              value={draft.auditLogRetentionSeconds === null ? '' : formatChars(draft.auditLogRetentionSeconds)}
            />
          </Field>
        </div>
      </SettingsExpander>

      <SettingsExpander
        defaultOpen={!promptsAtDefaults}
        description={t('dashboard.cyberIntercept.promptsDescription')}
        header={t('dashboard.cyberIntercept.promptsLabel')}
        icon={<Shield24Regular />}
      >
        <div className="grid gap-3">
          <Field label={t('dashboard.cyberIntercept.prefixPrompt')}>
            <Textarea
              className="font-mono text-[13px]"
              onChange={(_, data) => setField('prefixPrompt', data.value)}
              rows={16}
              value={draft.prefixPrompt}
            />
          </Field>
          <Field label={t('dashboard.cyberIntercept.suffixPrompt')}>
            <Textarea
              className="font-mono text-[13px]"
              onChange={(_, data) => setField('suffixPrompt', data.value)}
              rows={4}
              value={draft.suffixPrompt}
            />
          </Field>
          <div>
            <Button
              appearance="secondary"
              disabled={promptsAtDefaults}
              onClick={() => setDraft(current => ({ ...current, prefixPrompt: promptDefaults.prefixPrompt, suffixPrompt: promptDefaults.suffixPrompt }))}
            >
              {t('dashboard.cyberIntercept.resetPrompts')}
            </Button>
          </div>
        </div>
      </SettingsExpander>

      <div className="flex flex-col gap-[10px] sm:flex-row sm:items-center">
        <Button
          appearance="primary"
          disabledFocusable={saving}
          onClick={() => void handleSave()}
        >
          {t('dashboard.cyberIntercept.save')}
        </Button>
      </div>

      {saveError && (
        <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>
      )}
    </Panel>
  );
}

function CyberInterceptAuditList({ initialAudit, locale }: {
  initialAudit: CyberInterceptAuditRecord[];
  locale: string;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [audit, setAudit] = useState(initialAudit);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const purgeDialog = useDialogInvocation<void>();

  const refresh = useCallback(async (nextOffset: number) => {
    setLoading(true);
    const result = await callApi(() => api.api['cyber-intercept']['audit-log'].$get({
      query: { limit: String(AUDIT_PAGE_SIZE), offset: String(nextOffset) },
    }));
    setLoading(false);
    if (result.error) return;
    setAudit(result.data);
    setOffset(nextOffset);
  }, []);

  const purge = useCallback(async () => {
    const handle = toasts.start(t('dashboard.cyberIntercept.audit.purgePending'));
    const result = await callApi(() => api.api['cyber-intercept']['audit-log'].$delete());
    purgeDialog.close();
    if (result.error) {
      handle.settle();
      return;
    }
    handle.succeed(t('dashboard.cyberIntercept.audit.purgeSuccess'));
    await refresh(0);
  }, [t, toasts, purgeDialog, refresh]);

  const hasNewer = offset > 0;
  // A full page means there may be older rows; the next click empties when
  // there are not.
  const hasOlder = audit.length === AUDIT_PAGE_SIZE;

  return (
    <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader level={2} title={t('dashboard.cyberIntercept.audit.heading')} />
      {audit.length === 0
        ? <EmptyStateLine>{t('dashboard.cyberIntercept.audit.empty')}</EmptyStateLine>
        : <ResourceListPanel>
            <ScrollArea axes="horizontal" className="min-w-0">
              <Table aria-label={t('dashboard.cyberIntercept.audit.heading')} className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('dashboard.cyberIntercept.audit.time')}</TableHeaderCell>
                    <TableHeaderCell>{t('dashboard.cyberIntercept.audit.action')}</TableHeaderCell>
                    <TableHeaderCell>{t('dashboard.cyberIntercept.audit.reason')}</TableHeaderCell>
                    <TableHeaderCell>{t('dashboard.cyberIntercept.audit.judge')}</TableHeaderCell>
                    <TableHeaderCell>{t('dashboard.cyberIntercept.audit.request')}</TableHeaderCell>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audit.map(record => (
                    <TableRow key={record.id}>
                      <TableCell>{dateTime(record.createdAt, locale)}</TableCell>
                      <TableCell>{t(`dashboard.cyberIntercept.audit.actionTaken.${record.actionTaken}`)}</TableCell>
                      <TableCell>{record.reason}</TableCell>
                      <TableCell>{record.judgeModelId}</TableCell>
                      <TableCell><span className="font-mono text-[12px]">{record.requestMethod} {record.requestPath}</span></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          </ResourceListPanel>}
      <div className="flex justify-end gap-2">
        <Button disabled={loading || !hasNewer} onClick={() => void refresh(Math.max(0, offset - AUDIT_PAGE_SIZE))}>
          {t('dashboard.cyberIntercept.audit.newer')}
        </Button>
        <Button disabled={loading || !hasOlder} onClick={() => void refresh(offset + AUDIT_PAGE_SIZE)}>
          {t('dashboard.cyberIntercept.audit.older')}
        </Button>
        <TooltipIconButton
          icon={<DeleteRegular />}
          label={t('dashboard.cyberIntercept.audit.purge')}
          onClick={() => purgeDialog.open(undefined)}
        />
      </div>

      {purgeDialog.invocation && <ConfirmDialog
        actionLabel={t('dashboard.cyberIntercept.audit.purge')}
        busy={false}
        message={t('dashboard.cyberIntercept.audit.purgeConfirm')}
        onConfirm={() => void purge()}
        onOpenChange={open => { if (!open) purgeDialog.close(); }}
        open={purgeDialog.isOpen}
        title={t('dashboard.cyberIntercept.audit.purgeTitle')}
      />}
    </Panel>
  );
}
