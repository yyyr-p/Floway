import { ArrowClockwiseRegular, CalculatorRegular, CheckmarkCircleRegular, DatabaseRegular } from '@fluentui/react-icons';
import { useCallback, useMemo, useRef, useState } from 'react';

import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Checkbox, Dropdown, Input } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';
import { formatCount } from '../lib/format-number';
import { useLocale } from '../lib/use-locale';
import type { ApplyResult, BackfillIntent, BackfillPlan, InspectionResult } from '@floway-dev/gateway/usage-pricing-backfill';
import { BILLING_METRICS, type BillingMetric } from '@floway-dev/protocols/common';

const { Button, Field, Option, Spinner } = fluentComponents;

interface LoaderData {
  inspection: InspectionResult | null;
  error: string | null;
}

const loadInspection = async (): Promise<LoaderData> => {
  const result = await callApi(() => api.api['usage-pricing-backfill'].inspect.$get());
  return result.error ? { inspection: null, error: result.error.message } : { inspection: result.data, error: null };
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadInspection();
}

interface Draft extends BackfillIntent {
  inspectionFilterUpstream: string;
  inspectionFilterMetric: string;
  inspectionSearch: string;
}

const initialDraft = (): Draft => ({
  upstream: '',
  model: '',
  modelKey: '',
  startHour: '',
  endHour: '',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  metrics: [],
  mode: 'fill',
  inspectionFilterUpstream: '',
  inspectionFilterMetric: '',
  inspectionSearch: '',
});

const nextHour = (hour: string): string => {
  const parsed = new Date(`${hour}:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf())) return hour;
  parsed.setUTCHours(parsed.getUTCHours() + 1);
  return parsed.toISOString().slice(0, 13);
};

const databaseLabel = (database: InspectionResult['database']): string => {
  if (database.kind === 'node') return `${database.kind}: ${database.path}`;
  if (database.kind === 'd1') return `${database.kind} ${database.location}: ${database.databaseName} (${database.databaseId})`;
  return `${database.kind}: ${database.target}`;
};

const metricTranslationKey = (metric: BillingMetric): `dashboard.usagePricing.metricLabels.${BillingMetric}` =>
  `dashboard.usagePricing.metricLabels.${metric}`;

export default function DashboardAdminUsagePricing({ loaderData }: { loaderData: LoaderData }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [inspection, setInspection] = useState(loaderData.inspection);
  const [inspectionError, setInspectionError] = useState(loaderData.error);
  const [draft, setDraft] = useState<Draft>(() => ({
    ...initialDraft(),
    upstream: loaderData.inspection?.enabledUpstreams[0]?.id ?? '',
  }));
  const [plan, setPlan] = useState<BackfillPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [confirmationId, setConfirmationId] = useState('');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const planGeneration = useRef(0);

  const invalidatePlan = useCallback(() => {
    planGeneration.current++;
    setPlan(null);
    setConfirmationId('');
    setResult(null);
    setPlanError(null);
    setApplyError(null);
    setPlanLoading(false);
  }, []);

  const updateDraft = useCallback((change: Partial<Draft>) => {
    if (applying) return;
    invalidatePlan();
    setDraft(current => ({ ...current, ...change }));
  }, [applying, invalidatePlan]);

  const refreshInspection = useCallback(async () => {
    setRefreshing(true);
    const next = await loadInspection();
    setInspection(next.inspection);
    setInspectionError(next.error);
    setRefreshing(false);
  }, []);

  const upstreamNames = useMemo(() => new Map(
    (inspection?.enabledUpstreams ?? []).map(upstream => [upstream.id, upstream.name]),
  ), [inspection]);

  const visibleSlices = useMemo(() => {
    const search = draft.inspectionSearch.trim().toLocaleLowerCase();
    return (inspection?.nullPriceSlices ?? []).filter(slice => {
      if (draft.inspectionFilterUpstream && slice.upstream !== draft.inspectionFilterUpstream) return false;
      if (draft.inspectionFilterMetric && slice.metric !== draft.inspectionFilterMetric) return false;
      if (!search) return true;
      return [slice.upstream ?? '', upstreamNames.get(slice.upstream ?? '') ?? '', slice.model, slice.modelKey, slice.pricingSelector]
        .some(value => value.toLocaleLowerCase().includes(search));
    });
  }, [draft.inspectionFilterMetric, draft.inspectionFilterUpstream, draft.inspectionSearch, inspection, upstreamNames]);

  const selectSlice = (slice: InspectionResult['nullPriceSlices'][number]) => {
    if (applying) return;
    invalidatePlan();
    setDraft(current => ({
      ...current,
      upstream: slice.upstream ?? '',
      model: slice.model,
      modelKey: slice.modelKey,
      startHour: slice.firstHour.slice(0, 13),
      endHour: nextHour(slice.lastHour.slice(0, 13)),
      metrics: [slice.metric],
    }));
  };

  const createPlan = async () => {
    if (applying) return;
    const generation = ++planGeneration.current;
    const intent: BackfillIntent = {
      upstream: draft.upstream,
      model: draft.model,
      modelKey: draft.modelKey,
      startHour: draft.startHour,
      endHour: draft.endHour,
      timezone: draft.timezone,
      metrics: draft.metrics,
      mode: draft.mode,
    };
    setPlanLoading(true);
    setPlan(null);
    setConfirmationId('');
    setResult(null);
    setPlanError(null);
    setApplyError(null);
    const response = await callApi(() => api.api['usage-pricing-backfill'].plan.$post({ json: intent }));
    if (planGeneration.current !== generation) return;
    if (response.error) setPlanError(response.error.message);
    else setPlan(response.data);
    setPlanLoading(false);
  };

  const applyPlan = async () => {
    if (confirmationId !== plan?.planId || plan.blockers.length > 0 || plan.operations.length === 0) return;
    setApplying(true);
    setApplyError(null);
    const response = await callApi(() => api.api['usage-pricing-backfill'].apply.$post({
      json: { plan, confirmationPlanId: confirmationId },
    }));
    if (response.error) {
      setApplyError(response.error.message);
      setPlan(null);
      setConfirmationId('');
    } else {
      setResult(response.data);
      await refreshInspection();
    }
    setApplying(false);
  };

  const toggleMetric = (metric: BillingMetric, checked: boolean) => {
    const next = checked
      ? [...new Set([...draft.metrics, metric])]
      : draft.metrics.filter(value => value !== metric);
    updateDraft({ metrics: next });
  };

  const fmt = (value: number) => formatCount(value, locale);
  const scopeFieldsReady = Boolean(draft.upstream && draft.model && draft.modelKey && draft.startHour && draft.endHour && draft.timezone && draft.metrics.length > 0);
  const databaseIdentityAvailable = inspection !== null
    && (inspection.database.kind !== 'runtime' || inspection.database.stable);
  const canCreatePlan = scopeFieldsReady && databaseIdentityAvailable && !planLoading && !applying;
  const canApply = Boolean(plan && result === null && confirmationId === plan.planId && plan.blockers.length === 0 && plan.operations.length > 0 && !applying);

  return <section className="dashboard-page max-w-[1120px]">
    <DashboardPageHeader description={t('dashboard.pages.usagePricing')} title={t('dashboard.nav.usagePricing')} />
    {inspection?.database.kind === 'runtime' && !inspection.database.stable && <OutcomeMessageBar intent="warning">{t('dashboard.usagePricing.databaseIdentityWarning')}</OutcomeMessageBar>}

    <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader
        actions={<Button disabled={refreshing} icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={() => void refreshInspection()}>
          {t('dashboard.usagePricing.refresh')}
        </Button>}
        description={t('dashboard.usagePricing.inspectDescription')}
        level={2}
        title={t('dashboard.usagePricing.inspectHeading')}
      />
      {inspectionError && <OutcomeMessageBar intent="error" onDismiss={() => setInspectionError(null)}>{inspectionError}</OutcomeMessageBar>}
      {inspection && <>
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <Field className="min-w-[200px] flex-[1_1_240px]" label={t('dashboard.usagePricing.filterUpstream')}>
            <Dropdown
              className="w-full"
              selectedOptions={[draft.inspectionFilterUpstream]}
              value={draft.inspectionFilterUpstream ? upstreamNames.get(draft.inspectionFilterUpstream) ?? draft.inspectionFilterUpstream : t('dashboard.usagePricing.allUpstreams')}
              onOptionSelect={(_, data) => setDraft(current => ({ ...current, inspectionFilterUpstream: data.optionValue ?? '' }))}
            >
              <Option value="">{t('dashboard.usagePricing.allUpstreams')}</Option>
              {inspection.enabledUpstreams.map(upstream => <Option key={upstream.id} text={upstream.name} value={upstream.id}>{upstream.name}</Option>)}
            </Dropdown>
          </Field>
          <Field className="min-w-[180px] flex-[1_1_220px]" label={t('dashboard.usagePricing.filterMetric')}>
            <Dropdown
              className="w-full"
              selectedOptions={[draft.inspectionFilterMetric]}
              value={draft.inspectionFilterMetric ? t(metricTranslationKey(draft.inspectionFilterMetric as BillingMetric)) : t('dashboard.usagePricing.allMetrics')}
              onOptionSelect={(_, data) => setDraft(current => ({ ...current, inspectionFilterMetric: data.optionValue ?? '' }))}
            >
              <Option value="">{t('dashboard.usagePricing.allMetrics')}</Option>
              {BILLING_METRICS.map(metric => <Option key={metric} value={metric}>{t(metricTranslationKey(metric))}</Option>)}
            </Dropdown>
          </Field>
          <Field className="min-w-[220px] flex-[2_1_300px]" label={t('dashboard.usagePricing.search')}>
            <Input value={draft.inspectionSearch} onChange={(_, data) => setDraft(current => ({ ...current, inspectionSearch: data.value }))} />
          </Field>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead><tr className="border-b border-fui-stroke2 text-fui-fg2">
              <th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.upstream')}</th>
              <th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.model')}</th>
              <th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.modelKey')}</th>
              <th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.metric')}</th>
              <th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.rows')}</th>
              <th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.range')}</th>
              <th className="px-2 py-2" />
            </tr></thead>
            <tbody>{visibleSlices.map((slice, index) => <tr className="border-b border-fui-stroke2" key={`${slice.upstream}:${slice.model}:${slice.modelKey}:${slice.pricingSelector}:${slice.metric}:${index}`}>
              <td className="max-w-[220px] truncate px-2 py-2" title={slice.upstream ?? ''}>{upstreamNames.get(slice.upstream ?? '') ?? slice.upstream ?? t('dashboard.usagePricing.unknownUpstream')}</td>
              <td className="max-w-[220px] truncate px-2 py-2 font-mono" title={slice.model}>{slice.model}</td>
              <td className="max-w-[220px] truncate px-2 py-2 font-mono" title={slice.modelKey}>{slice.modelKey}</td>
              <td className="px-2 py-2">{t(metricTranslationKey(slice.metric))}</td>
              <td className="px-2 py-2 tabular-nums">{fmt(slice.rows)}</td>
              <td className="whitespace-nowrap px-2 py-2 font-mono text-xs">{t('dashboard.usagePricing.rangeValue', { start: slice.firstHour.slice(0, 13), end: slice.lastHour.slice(0, 13) })}</td>
              <td className="px-2 py-2"><Button appearance="subtle" disabled={applying} onClick={() => selectSlice(slice)}>{t('dashboard.usagePricing.select')}</Button></td>
            </tr>)}</tbody>
          </table>
        </div>
        {visibleSlices.length === 0 && <EmptyStateLine>{t('dashboard.usagePricing.noSlices')}</EmptyStateLine>}
      </>}
    </Panel>

    <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader description={t('dashboard.usagePricing.scopeDescription')} level={2} title={t('dashboard.usagePricing.scopeHeading')} />
      <div className="grid grid-cols-2 gap-3 max-[680px]:grid-cols-1">
        <Field label={t('dashboard.usagePricing.upstream')}>
          <Dropdown className="w-full" disabled={applying} selectedOptions={[draft.upstream]} value={upstreamNames.get(draft.upstream) ?? draft.upstream} onOptionSelect={(_, data) => updateDraft({ upstream: data.optionValue ?? '' })}>
            {inspection?.enabledUpstreams.map(upstream => <Option key={upstream.id} text={upstream.name} value={upstream.id}>{upstream.name}</Option>)}
          </Dropdown>
        </Field>
        <Field label={t('dashboard.usagePricing.model')}><Input className="font-mono" disabled={applying} value={draft.model} onChange={(_, data) => updateDraft({ model: data.value })} /></Field>
        <Field label={t('dashboard.usagePricing.modelKey')}><Input className="font-mono" disabled={applying} value={draft.modelKey} onChange={(_, data) => updateDraft({ modelKey: data.value })} /></Field>
        <Field hint={t('dashboard.usagePricing.utcHourHint')} label={t('dashboard.usagePricing.startHour')}><Input className="font-mono" disabled={applying} placeholder="YYYY-MM-DDTHH" value={draft.startHour} onChange={(_, data) => updateDraft({ startHour: data.value })} /></Field>
        <Field hint={t('dashboard.usagePricing.utcHourHint')} label={t('dashboard.usagePricing.endHour')}><Input className="font-mono" disabled={applying} placeholder="YYYY-MM-DDTHH" value={draft.endHour} onChange={(_, data) => updateDraft({ endHour: data.value })} /></Field>
        <Field label={t('dashboard.usagePricing.timezone')}><Input className="font-mono" disabled={applying} value={draft.timezone} onChange={(_, data) => updateDraft({ timezone: data.value })} /></Field>
        <Field label={t('dashboard.usagePricing.mode')}>
          <Dropdown className="w-full" disabled={applying} selectedOptions={[draft.mode]} value={t(`dashboard.usagePricing.modeValue.${draft.mode}`)} onOptionSelect={(_, data) => data.optionValue && updateDraft({ mode: data.optionValue as BackfillIntent['mode'] })}>
            <Option value="fill">{t('dashboard.usagePricing.modeValue.fill')}</Option>
            <Option value="overwrite">{t('dashboard.usagePricing.modeValue.overwrite')}</Option>
          </Dropdown>
        </Field>
      </div>
      <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend className="mb-1 text-sm font-medium">{t('dashboard.usagePricing.metrics')}</legend>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-[680px]:grid-cols-1">
          {BILLING_METRICS.map(metric => <Checkbox key={metric} checked={draft.metrics.includes(metric)} disabled={applying} label={t(metricTranslationKey(metric))} onChange={(_, data) => toggleMetric(metric, data.checked === true)} />)}
        </div>
      </fieldset>
      {draft.mode === 'overwrite' && <OutcomeMessageBar intent="warning">{t('dashboard.usagePricing.overwriteWarning')}</OutcomeMessageBar>}
      <div className="flex flex-wrap items-center gap-2">
        <Button appearance="primary" disabled={!canCreatePlan} icon={planLoading ? <Spinner size="tiny" /> : <CalculatorRegular />} onClick={() => void createPlan()}>
          {t('dashboard.usagePricing.createPlan')}
        </Button>
        {planError && <OutcomeMessageBar intent="error" onDismiss={() => setPlanError(null)}>{planError}</OutcomeMessageBar>}
      </div>
    </Panel>

    {plan && <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader description={t('dashboard.usagePricing.planDescription')} level={2} title={t('dashboard.usagePricing.planHeading')} />
      <OutcomeMessageBar intent={plan.blockers.length > 0 ? 'error' : 'info'}>
        <span>{t('dashboard.usagePricing.planId')}: <code className="break-all font-mono">{plan.planId}</code></span>
      </OutcomeMessageBar>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 max-[680px]:grid-cols-1">
        <div><dt className="text-fui-fg2">{t('dashboard.usagePricing.database')}</dt><dd className="m-0 break-all font-mono">{databaseLabel(plan.database)}</dd></div>
        <div><dt className="text-fui-fg2">{t('dashboard.usagePricing.pricingSource')}</dt><dd className="m-0 break-all font-mono">{plan.pricing.source ?? plan.pricing.reason ?? plan.pricing.status}</dd></div>
        <div><dt className="text-fui-fg2">{t('dashboard.usagePricing.pricingStatus')}</dt><dd className="m-0">{t(`dashboard.usagePricing.pricingValue.${plan.pricing.status}`)}</dd></div>
        <div><dt className="text-fui-fg2">{t('dashboard.usagePricing.selectedRows')}</dt><dd className="m-0 tabular-nums">{fmt(plan.summary.selectedRows)}</dd></div>
        <div><dt className="text-fui-fg2">{t('dashboard.usagePricing.rowsToUpdate')}</dt><dd className="m-0 tabular-nums">{fmt(plan.summary.rowsToUpdate)}</dd></div>
        <div><dt className="text-fui-fg2">{t('dashboard.usagePricing.remainingNullRows')}</dt><dd className="m-0 tabular-nums">{fmt(plan.summary.remainingNullRows)}</dd></div>
      </dl>
      {plan.pricing.digest && <p className="m-0 break-all font-mono text-xs">{t('dashboard.usagePricing.pricingDigest')}: {plan.pricing.digest}</p>}
      <div className="grid gap-1 text-xs">
        <p className="m-0 break-all font-mono">{t('dashboard.usagePricing.configurationDigest')}: {plan.guards.upstreamConfigDigest}</p>
        {plan.guards.upstreamModelsCacheDigest && <p className="m-0 break-all font-mono">{t('dashboard.usagePricing.catalogDigest')}: {plan.guards.upstreamModelsCacheDigest}</p>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead><tr className="border-b border-fui-stroke2 text-fui-fg2"><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.selector')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.metric')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.proposedRate')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.rows')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.exampleCost')}</th></tr></thead>
          <tbody>{plan.operations.map(operation => <tr className="border-b border-fui-stroke2" key={`${operation.pricingSelector}:${operation.metric}`}>
            <td className="max-w-[280px] break-all px-2 py-2 font-mono text-xs">{operation.pricingSelector}</td>
            <td className="px-2 py-2">{t(metricTranslationKey(operation.metric))}</td>
            <td className="px-2 py-2 font-mono">{operation.proposedUnitPrice}</td>
            <td className="px-2 py-2 tabular-nums">{fmt(operation.expectedRows)}</td>
            <td className="px-2 py-2 font-mono">{operation.representative.realizedCost}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <div>
        <h3 className="m-0 mb-2 text-base font-semibold">{t('dashboard.usagePricing.snapshotHeading')}</h3>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead><tr className="border-b border-fui-stroke2 text-fui-fg2"><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.selector')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.metric')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.currentRate')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.rows')}</th></tr></thead>
            <tbody>{plan.snapshot.map((state, index) => <tr className="border-b border-fui-stroke2" key={`${state.pricingSelector}:${state.metric}:${state.unitPrice ?? 'null'}:${index}`}>
              <td className="max-w-[280px] break-all px-2 py-2 font-mono text-xs">{state.pricingSelector}</td>
              <td className="px-2 py-2">{t(metricTranslationKey(state.metric))}</td>
              <td className="px-2 py-2 font-mono">{state.unitPrice ?? 'NULL'}</td>
              <td className="px-2 py-2 tabular-nums">{fmt(state.rows)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </div>
      {plan.skipped.length > 0 && <div>
        <h3 className="m-0 mb-2 text-base font-semibold">{t('dashboard.usagePricing.skippedHeading')}</h3>
        <ul className="m-0 grid gap-1 pl-5">{plan.skipped.map(item => <li key={`${item.pricingSelector}:${item.metric}:${item.reason}`}>
          <code className="font-mono">{item.pricingSelector}</code> | {t(metricTranslationKey(item.metric))} | {fmt(item.nullRows)} | {t(`dashboard.usagePricing.skipReason.${item.reason}`)}
        </li>)}</ul>
      </div>}
      {plan.blockers.length > 0 && <div>
        <h3 className="m-0 mb-2 text-base font-semibold">{t('dashboard.usagePricing.blockersHeading')}</h3>
        <ul className="m-0 grid gap-1 pl-5">{plan.blockers.map(blocker => <li key={`${blocker.code}:${blocker.message}`}><strong>{blocker.code}</strong>: {blocker.message}</li>)}</ul>
      </div>}
      <Field hint={t('dashboard.usagePricing.confirmHint', { planId: plan.planId })} label={t('dashboard.usagePricing.confirmLabel')}>
        <Input autoComplete="off" className="font-mono" disabled={applying} value={confirmationId} onChange={(_, data) => setConfirmationId(data.value)} />
      </Field>
      <div><Button appearance="primary" disabled={!canApply} icon={applying ? <Spinner size="tiny" /> : <DatabaseRegular />} onClick={() => void applyPlan()}>
        {t('dashboard.usagePricing.apply')}
      </Button></div>
    </Panel>}

    {plan?.operations.length === 0 && <OutcomeMessageBar intent="info">{t('dashboard.usagePricing.noOperations')}</OutcomeMessageBar>}
    {applyError && <OutcomeMessageBar intent="error" onDismiss={() => setApplyError(null)}>{applyError}</OutcomeMessageBar>}

    {result && <Panel className={PANEL_STACK_CLASS}>
      <SectionHeader description={t('dashboard.usagePricing.verificationDescription')} level={2} title={t('dashboard.usagePricing.verificationHeading')} />
      <OutcomeMessageBar intent="success">
        <span className="inline-flex items-center gap-2"><CheckmarkCircleRegular />{t('dashboard.usagePricing.verifiedSummary', { updated: result.rowsUpdated, remaining: result.summary.remainingNullRows })}</span>
      </OutcomeMessageBar>
      {Object.keys(result.summary.remainingNullRowsByMetric).length > 0 && <div>
        <h3 className="m-0 mb-2 text-base font-semibold">{t('dashboard.usagePricing.remainingByMetric')}</h3>
        <ul className="m-0 grid gap-1 pl-5">{Object.entries(result.summary.remainingNullRowsByMetric).map(([metric, rows]) => rows === undefined ? null : <li key={metric}>{t(metricTranslationKey(metric as BillingMetric))}: {fmt(rows)}</li>)}</ul>
      </div>}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm">
          <thead><tr className="border-b border-fui-stroke2 text-fui-fg2"><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.selector')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.metric')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.proposedRate')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.rows')}</th><th className="px-2 py-2 font-medium">{t('dashboard.usagePricing.remainingNullRows')}</th></tr></thead>
          <tbody>{result.operations.map(operation => <tr className="border-b border-fui-stroke2" key={`${operation.pricingSelector}:${operation.metric}`}>
            <td className="max-w-[280px] break-all px-2 py-2 font-mono text-xs">{operation.pricingSelector}</td>
            <td className="px-2 py-2">{t(metricTranslationKey(operation.metric))}</td>
            <td className="px-2 py-2 font-mono">{operation.proposedUnitPrice}</td>
            <td className="px-2 py-2 tabular-nums">{fmt(operation.expectedRows)}</td>
            <td className="px-2 py-2 tabular-nums">{fmt(operation.remainingNullRows)}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </Panel>}
  </section>;
}
