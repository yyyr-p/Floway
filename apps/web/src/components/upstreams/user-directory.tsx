import { ProviderBadge } from './provider-badge';
import type { VisibleUpstream } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DashboardPageHeader } from '../ui/dashboard-page-header';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ResourceListEmptyState, ResourceListPanel } from '../ui/resource-list';
import { ScrollArea } from '../ui/scroll-area';
import { TableColumns } from '../ui/table-columns';

const { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } = fluentComponents;

export function UserUpstreamDirectory({ loadFailed, upstreams }: {
  loadFailed: boolean;
  upstreams: VisibleUpstream[] | null;
}) {
  const { t } = useTranslation();
  return <section className="dashboard-page">
    <DashboardPageHeader
      title={t('dashboard.nav.upstreams')}
    />
    {loadFailed && <OutcomeMessageBar>{t('dashboard.upstreams.directory.loadFailed')}</OutcomeMessageBar>}
    <ResourceListPanel rowHeight="56px">
      {upstreams === null ? null : upstreams.length === 0
        ? <ResourceListEmptyState>{t('dashboard.upstreams.directory.empty')}</ResourceListEmptyState>
        : <ScrollArea axes="horizontal" className="min-w-0">
            <Table aria-label={t('dashboard.upstreams.directory.tableLabel')} className="min-w-[420px]">
              <TableColumns widths={[null, '200px']} />
              <TableHeader><TableRow>
                <TableHeaderCell>{t('dashboard.upstreams.table.upstream')}</TableHeaderCell>
                <TableHeaderCell>{t('dashboard.upstreams.directory.provider')}</TableHeaderCell>
              </TableRow></TableHeader>
              <TableBody>
                {upstreams.map(upstream => <TableRow key={upstream.id}>
                  <TableCell>
                    <ProviderBadge label={upstream.name} upstream={{ hue: upstream.hue, kind: upstream.kind }} />
                  </TableCell>
                  <TableCell>{t(`provider.${upstream.kind}`)}</TableCell>
                </TableRow>)}
              </TableBody>
            </Table>
          </ScrollArea>}
    </ResourceListPanel>
  </section>;
}
