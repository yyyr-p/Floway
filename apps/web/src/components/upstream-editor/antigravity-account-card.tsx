import { ArrowClockwiseRegular } from '@fluentui/react-icons';

import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, relativeTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { StatusBadge } from '../ui/status-badge';
import { ProviderIcon } from '../upstreams/provider-badge';
import { WALL_CLOCK_REFRESH_MS } from '../upstreams/subscription-quota';

type AntigravityRecord = Extract<UpstreamRecord, { kind: 'antigravity' }> & {
  state: NonNullable<Extract<UpstreamRecord, { kind: 'antigravity' }>['state']>;
};

const { Button, Spinner, Text } = fluentComponents;

// One account, the way the codex and claude-code cards render one: identity
// from the config, credential health from the state, and the token's remaining
// life off the wall clock. Antigravity publishes no quota snapshot, so there
// are no window rows to draw — the state badge and the token expiry are all
// the upstream reports.
export function AntigravityAccountCard({ onRefresh, refreshing, record }: {
  onRefresh: () => void;
  refreshing: boolean;
  record: AntigravityRecord;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow(WALL_CLOCK_REFRESH_MS);
  const identity = record.config.accounts[0];
  const credential = record.state.accounts[0];
  const terminal = credential.state !== 'active';
  const email = credential.email || identity.email;
  const accessTokenExpiresAt = credential.accessToken?.expiresAt ?? null;

  return <section className="grid gap-4">
    <div className="flex items-start gap-3">
      <ProviderIcon kind="antigravity" className="h-8 w-8 shrink-0" />
      <div className="grid gap-1 min-w-0 flex-1">
        <Text block weight="semibold" truncate wrap={false}>
          {email ?? t('dashboard.upstreamEditor.antigravity.unknownEmail')}
        </Text>
        <div className="flex flex-wrap items-center gap-2">
          {identity.tierId !== null && <StatusBadge tone="accent">{identity.tierId}</StatusBadge>}
          {identity.projectId !== null && <Text size={200} className="text-fui-fg3 font-mono mono-size-xs">{identity.projectId}</Text>}
        </div>
      </div>
      <StatusBadge tone={terminal ? 'danger' : 'success'}>
        {terminal
          ? (credential.stateMessage ?? t(`dashboard.upstreams.antigravity.state.${credential.state}`))
          : t('dashboard.upstreams.antigravity.state.active')}
      </StatusBadge>
    </div>

    <div className="flex flex-wrap gap-x-4 gap-y-1 border-0 border-t border-solid border-fui-divider pt-3">
      <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.antigravity.stateUpdated', { time: dateTime(credential.stateUpdatedAt, locale) })}
      </Text>
      {accessTokenExpiresAt !== null && <Text size={200} className="text-fui-fg3">
        {t('dashboard.upstreamEditor.antigravity.tokenExpires', { time: relativeTime(accessTokenExpiresAt, locale, { now }) ?? dateTime(accessTokenExpiresAt, locale) })}
      </Text>}
    </div>

    <div className="flex flex-wrap items-center gap-2">
      <Button appearance="subtle" disabled={terminal} disabledFocusable={refreshing} icon={refreshing ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={onRefresh} size="small">
        {t('dashboard.upstreamEditor.oauth.refresh')}
      </Button>
    </div>
  </section>;
}
