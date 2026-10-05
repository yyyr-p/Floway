import { expect, test } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { createBody, hasUnsavedDiscoveryInputs, previewRecord, updateBody, valuesFromRecord } from '../../../src/components/upstream-editor/data';
import { upstreamRecord } from '../../api/upstream-fixture';

type CustomRecord = Extract<UpstreamRecord, { kind: 'custom' }>;

const record = upstreamRecord('up_custom', {
  kind: 'custom',
  config: {
    baseUrl: 'https://api.example.com',
    authStyle: 'bearer',
    apiKey: '',
    endpoints: { openaiResponses: {} },
    ingressHeadersRules: [
      { key: 'x-pass', value: null },
      { key: 'x-empty', value: '' },
      { key: 'x-route', value: 'fast' },
    ],
    modelsFetch: { enabled: false },
    models: [],
  },
  state: null,
}) as CustomRecord;

test('Custom editor values add one blank ingress row and never serialize it', () => {
  const values = valuesFromRecord(record);
  const config = values.config as CustomRecord['config'];
  expect(config.ingressHeadersRules).toEqual([
    { key: 'x-pass', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'fast' },
    { key: '', value: null },
  ]);

  config.ingressHeadersRules[0]!.key = ' X-PASS ';
  const expected = [
    { key: 'x-pass', value: null },
    { key: 'x-empty', value: '' },
    { key: 'x-route', value: 'fast' },
  ];
  expect((createBody(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((updateBody(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
  expect((previewRecord(record, values).config as CustomRecord['config']).ingressHeadersRules).toEqual(expected);
});

test('Custom editor round-trips usage probes and actions without serializing editor-only fields', () => {
  const configured = upstreamRecord('up_custom', {
    kind: 'custom',
    config: {
      baseUrl: 'https://api.example.com',
      authStyle: 'none',
      endpoints: { openaiResponses: {} },
      ingressHeadersRules: [],
      modelsFetch: { enabled: false },
      models: [],
      usageProbe: {
        path: '/account/usage',
        windows: [{ id: 'week', label: 'Weekly', used: '/usage/used', limit: '/usage/limit' }],
      },
      actions: [{ id: 'reset', label: 'Reset quota', path: '/account/reset', method: 'POST' }],
    },
    state: null,
  }) as CustomRecord;
  const values = valuesFromRecord(configured);
  const config = values.config as CustomRecord['config'] & { usageProbeJson: string; actionsJson: string };
  expect(JSON.parse(config.usageProbeJson)).toEqual(config.usageProbe);
  expect(JSON.parse(config.actionsJson)).toEqual(config.actions);

  config.usageProbeJson = JSON.stringify({
    path: '/v2/usage',
    windows: [{ id: 'day', label: 'Daily', used: '/day/used', limit: '/day/limit' }],
  });
  config.actionsJson = JSON.stringify([{ id: 'refresh', label: 'Refresh', path: '/account/refresh', method: 'PUT' }]);
  const preview = previewRecord(configured, values).config as CustomRecord['config'] & Record<string, unknown>;
  expect(preview.usageProbe).toEqual(JSON.parse(config.usageProbeJson));
  expect(preview.actions).toEqual(JSON.parse(config.actionsJson));
  expect(preview.usageProbeJson).toBeUndefined();
  expect(preview.actionsJson).toBeUndefined();
});

test('discovery input edits exclude metadata-only changes', () => {
  expect(hasUnsavedDiscoveryInputs({})).toBe(false);
  expect(hasUnsavedDiscoveryInputs({ config: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ state: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ proxyFallbackList: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ flagOverrides: true })).toBe(true);
  expect(hasUnsavedDiscoveryInputs({ name: true })).toBe(false);
});
