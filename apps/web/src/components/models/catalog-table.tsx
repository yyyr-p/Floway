import { ChevronDownRegular, ChevronLeftRegular, ChevronRightRegular, ChevronUpRegular } from '@fluentui/react-icons';
import { Fragment, useMemo, useState } from 'react';

import type { CatalogIndex } from './catalog-index';
import { CatalogMetadata } from './catalog-metadata';
import { filterCatalogModels, paginateCatalogModels } from './catalog-view';
import { ModelInfoBadges } from './info-badges';
import type { ControlPlaneModel } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { Input } from '../ui/fluent-form-controls';
import { ResourceListEmptyState, ResourceListPanel } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const { Field, Table, TableBody, TableCell, TableCellLayout, TableHeader, TableHeaderCell, TableRow, Text } = fluentComponents;

export function ModelCatalogTable({ cap, catalog, models }: {
  cap: readonly string[] | null;
  catalog: CatalogIndex;
  models: readonly ControlPlaneModel[];
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [requestedPage, setRequestedPage] = useState(1);
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  const filtered = useMemo(() => filterCatalogModels(models, query), [models, query]);
  const { items, page, pageCount } = useMemo(() => paginateCatalogModels(filtered, requestedPage), [filtered, requestedPage]);

  return <div className="grid min-w-0 gap-3">
    <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
      <Field label={t('dashboard.modelsCatalog.search')} className="min-w-0 flex-1 max-w-[460px]">
        <Input value={query} onChange={(_, data) => {
          setQuery(data.value);
          setRequestedPage(1);
          setExpandedModelId(null);
        }} />
      </Field>
      <Text size={200} className="min-w-0 break-words text-fui-fg2" aria-live="polite">
        {t('dashboard.modelsCatalog.count', { count: filtered.length })}
      </Text>
    </div>
    <ResourceListPanel rowHeight="64px">
      {models.length === 0
        ? <ResourceListEmptyState>{t('dashboard.modelsCatalog.empty')}</ResourceListEmptyState>
        : filtered.length === 0
          ? <ResourceListEmptyState>{t('dashboard.modelsCatalog.noMatches')}</ResourceListEmptyState>
          : <ScrollArea axes="horizontal" className="min-w-0">
              <Table aria-label={t('dashboard.modelsCatalog.tableLabel')} className="min-w-[700px]">
                <TableColumns widths={[null, '112px', '38%', '44px']} />
                <TableHeader>
                  <TableRow>
                    <TableHeaderCell>{t('dashboard.modelsCatalog.columns.model')}</TableHeaderCell>
                    <TableHeaderCell>{t('dashboard.modelsCatalog.columns.kind')}</TableHeaderCell>
                    <TableHeaderCell>{t('dashboard.modelsCatalog.columns.metadata')}</TableHeaderCell>
                    <TableHeaderCell aria-label={t('dashboard.modelsCatalog.columns.details')} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map(model => {
                    const expanded = expandedModelId === model.id;
                    const detailLabel = t(`dashboard.modelsCatalog.${expanded ? 'hideDetails' : 'showDetails'}`, { model: model.display_name });
                    return <Fragment key={model.id}>
                      <TableRow>
                        <TableCell className="min-w-0 overflow-hidden">
                          <TableCellLayout description={<span className="block min-w-0 truncate font-mono text-fui-fg2" title={model.id}>{model.id}</span>} truncate>
                            <span className="block min-w-0 truncate" title={model.display_name}>{model.display_name}</span>
                          </TableCellLayout>
                        </TableCell>
                        <TableCell className="min-w-0">
                          <Text block truncate wrap={false} size={200} className="min-w-0" title={t(`dashboard.modelsCatalog.kinds.${model.kind}`)}>
                            {t(`dashboard.modelsCatalog.kinds.${model.kind}`)}
                          </Text>
                        </TableCell>
                        <TableCell className="min-w-0 overflow-hidden">
                          <ModelInfoBadges cap={cap} catalog={catalog} model={model} />
                        </TableCell>
                        <TableCell>
                          <TooltipIconButton
                            ariaExpanded={expanded}
                            icon={expanded ? <ChevronUpRegular /> : <ChevronDownRegular />}
                            label={detailLabel}
                            onClick={() => setExpandedModelId(expanded ? null : model.id)}
                          />
                        </TableCell>
                      </TableRow>
                      {expanded && <TableRow key={`${model.id}:metadata`}>
                        <TableCell colSpan={4} className="!py-3">
                          <div className="grid min-w-0 gap-2">
                            <Text as="h3" size={300} weight="semibold" className="m-0">{t('dashboard.modelsCatalog.metadata.heading')}</Text>
                            <CatalogMetadata model={model} />
                          </div>
                        </TableCell>
                      </TableRow>}
                    </Fragment>;
                  })}
                </TableBody>
              </Table>
            </ScrollArea>}
      {filtered.length > 0 && <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 border-t border-fui-divider px-[var(--floway-panel-inset)] py-2">
        {pageCount > 1 && <>
          <TooltipIconButton disabled={page === 1} icon={<ChevronLeftRegular />} label={t('dashboard.modelsCatalog.previousPage')} onClick={() => { setRequestedPage(page - 1); setExpandedModelId(null); }} />
          <Text size={200} className="min-w-[90px] text-center">{t('dashboard.modelsCatalog.page', { current: page, total: pageCount })}</Text>
          <TooltipIconButton disabled={page === pageCount} icon={<ChevronRightRegular />} label={t('dashboard.modelsCatalog.nextPage')} onClick={() => { setRequestedPage(page + 1); setExpandedModelId(null); }} />
        </>}
      </div>}
    </ResourceListPanel>
  </div>;
}
