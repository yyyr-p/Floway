import { fireEvent, screen } from '@testing-library/react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { expect, test, vi } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import type { UpstreamEditorValues } from '../../../src/components/upstream-editor/data';
import { valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { ProviderConfigSection } from '../../../src/components/upstream-editor/provider-config';
import { i18n } from '../../../src/i18n';
import { upstreamRecord } from '../../api/upstream-fixture';
import { renderInApp } from '../../render';

const record = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'none',
    endpoints: { openaiChatCompletions: {} },
    ingressHeadersRules: [],
    modelsFetch: { enabled: false },
    models: [],
  },
  state: null,
}) as Extract<UpstreamRecord, { kind: 'custom' }>;

function Harness() {
  const form = useForm<UpstreamEditorValues>({ defaultValues: valuesFromRecord(record) });
  const config = useWatch({ control: form.control, name: 'config' });
  return <FormProvider {...form}>
    <ProviderConfigSection record={record} onPatch={vi.fn()} onRefreshModels={vi.fn()} />
    <output data-testid="custom-config">{JSON.stringify(config)}</output>
  </FormProvider>;
}

test('custom management JSON fields update the draft configuration', () => {
  renderInApp(<Harness />);
  fireEvent.change(screen.getByLabelText(i18n.t('dashboard.upstreamEditor.management.usageProbe')), {
    target: { value: '{"path":"/usage","windows":[{"id":"day","label":"Daily","used":"/used","limit":"/limit"}]}' },
  });
  fireEvent.change(screen.getByLabelText(i18n.t('dashboard.upstreamEditor.management.actions')), {
    target: { value: '[{"id":"reset","label":"Reset quota","path":"/reset","method":"POST"}]' },
  });

  const config = JSON.parse(screen.getByTestId('custom-config').textContent ?? '{}') as Record<string, unknown>;
  expect(config.usageProbe).toEqual({
    path: '/usage',
    windows: [{ id: 'day', label: 'Daily', used: '/used', limit: '/limit' }],
  });
  expect(config.actions).toEqual([{ id: 'reset', label: 'Reset quota', path: '/reset', method: 'POST' }]);
});
