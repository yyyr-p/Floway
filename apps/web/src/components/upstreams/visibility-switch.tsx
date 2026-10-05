import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';

const { Switch } = fluentComponents;

export function UpstreamVisibilitySwitch({
  checked,
  disabled,
  name,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  name: string;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return <Switch
    aria-label={t('dashboard.upstreams.actions.toggleVisibilityNamed', { name })}
    checked={checked}
    disabled={disabled}
    onChange={(_, detail) => onChange(detail.checked)}
  />;
}
