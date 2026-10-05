import type { ReactNode } from 'react';

import type { ControlPlaneModel } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Text } = fluentComponents;

function MetadataField({ label, value }: { label: string; value: ReactNode }) {
  return <div className="grid min-w-0 grid-cols-[minmax(112px,0.4fr)_minmax(0,1fr)] gap-x-3 max-[680px]:grid-cols-[minmax(96px,0.4fr)_minmax(0,1fr)]">
    <dt><Text size={200} className="text-fui-fg2">{label}</Text></dt>
    <dd className="m-0 min-w-0"><Text size={200} className="block min-w-0 [overflow-wrap:anywhere]">{value}</Text></dd>
  </div>;
}

export function CatalogMetadata({ model }: { model: ControlPlaneModel }) {
  const { t } = useTranslation();
  const unknown = t('dashboard.modelsCatalog.metadata.unknown');
  const none = t('dashboard.modelsCatalog.metadata.none');
  const booleanValue = (value: boolean | undefined) => value === undefined
    ? unknown
    : t(value ? 'dashboard.modelsCatalog.metadata.yes' : 'dashboard.modelsCatalog.metadata.no');
  const listValue = (values: readonly string[] | undefined) => values === undefined
    ? unknown
    : values.length === 0 ? none : values.join(', ');
  const endpoints = Object.keys(model.endpoints);
  const reasoning = model.chat?.reasoning;
  const pricing = model.pricing === undefined
    ? unknown
    : model.pricing.entries.length === 0
      ? none
      : model.pricing.entries.map(entry => JSON.stringify({ selector: entry.selector ?? {}, rates: entry.rates })).join('; ');
  const alias = model.aliasedFrom;
  const aliasTargets = alias?.targets.map(target => target.target_model_id);
  const compatibilityScope = model.opaqueBlobCompatibilityScope;

  return <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-2 max-[680px]:grid-cols-1">
    <MetadataField label={t('dashboard.modelsCatalog.metadata.kind')} value={t(`dashboard.modelsCatalog.kinds.${model.kind}`)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.owner')} value={model.owned_by ?? unknown} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.created')} value={model.created === undefined ? unknown : String(model.created)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.createdAt')} value={model.created_at ?? unknown} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.endpoints')} value={listValue(endpoints)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.context')} value={model.limits.max_context_window_tokens === undefined ? unknown : String(model.limits.max_context_window_tokens)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.prompt')} value={model.limits.max_prompt_tokens === undefined ? unknown : String(model.limits.max_prompt_tokens)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.output')} value={model.limits.max_output_tokens === undefined ? unknown : String(model.limits.max_output_tokens)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.inputModalities')} value={listValue(model.chat?.modalities?.input)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.outputModalities')} value={listValue(model.chat?.modalities?.output)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.imageDetailOriginal')} value={booleanValue(model.chat?.image_detail_original)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.reasoningEffort')} value={listValue(reasoning?.effort?.supported)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.defaultEffort')} value={reasoning?.effort?.default ?? unknown} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.reasoningBudgetMin')} value={reasoning?.budget_tokens?.min === undefined ? unknown : String(reasoning.budget_tokens.min)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.reasoningBudgetMax')} value={reasoning?.budget_tokens?.max === undefined ? unknown : String(reasoning.budget_tokens.max)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.adaptive')} value={booleanValue(reasoning?.adaptive)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.mandatory')} value={booleanValue(reasoning?.mandatory)} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.pricing')} value={pricing} />
    <MetadataField label={t('dashboard.modelsCatalog.metadata.bindToUpstream')} value={booleanValue(compatibilityScope.bindToUpstream)} />
    <MetadataField
      label={t('dashboard.modelsCatalog.metadata.compatibilityKey')}
      value={compatibilityScope.key ?? t('dashboard.modelsCatalog.metadata.upstreamModelId')}
    />
    {alias !== undefined && aliasTargets !== undefined && <>
      <MetadataField label={t('dashboard.modelsCatalog.metadata.aliasSelection')} value={t(`dashboard.models.badges.selectionValues.${alias.selection === 'first-available' ? 'firstAvailable' : 'random'}`)} />
      <MetadataField label={t('dashboard.modelsCatalog.metadata.aliasTargets')} value={listValue(aliasTargets)} />
    </>}
  </dl>;
}
