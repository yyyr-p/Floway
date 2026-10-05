import { screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import type { UpstreamRecord } from '../../../src/api/types';
import { hasSubscriptionDetails, upstreamDetailsPath, type SubscriptionUpstreamRecord } from '../../../src/components/upstream-details/data';
import { SubscriptionUpstreamDetailsPage } from '../../../src/components/upstream-details/page';
import { renderInApp } from '../../render';

const record = (kind: UpstreamRecord['kind'], config: unknown): UpstreamRecord => ({
  id: 'up_subscription',
  kind,
  name: 'Subscription upstream',
  enabled: true,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  flag_overrides: {},
  flag_defaults: {},
  disabled_public_model_ids: [],
  proxy_fallback_list: [],
  model_prefix: null,
  hue: 210,
  modelsCache: { fetchedAt: null, lastError: null, modelCount: null },
  config,
  state: kind === 'copilot'
    ? { copilotToken: { token: 'session-secret', expiresAt: Date.now() + 60_000, baseUrl: 'https://api.githubcopilot.com' }, seat: null, quotaSnapshot: null }
    : null,
} as unknown as UpstreamRecord);

describe('subscription upstream details', () => {
  it('only opens the operator detail page for subscription-backed readings', () => {
    const copilot = record('copilot', {
      githubHost: 'github.com',
      user: { id: '123', login: 'octocat', name: 'Octo Cat' },
      githubToken: 'github-secret',
      githubTokenSet: true,
    });
    const ollamaCloud = record('ollama', { baseUrl: 'https://ollama.com', apiKeySet: true, cloudUsage: true, models: [] });
    const ollamaLocal = record('ollama', { baseUrl: 'http://localhost:11434', apiKeySet: false, cloudUsage: false, models: [] });
    const custom = record('custom', { baseUrl: 'https://api.example.test', authStyle: 'none', endpoints: {}, ingressHeadersRules: [], modelsFetch: { enabled: false }, models: [] });

    expect(hasSubscriptionDetails(copilot)).toBe(true);
    expect(upstreamDetailsPath(copilot)).toBe('/dashboard/providers/upstreams/up_subscription/details');
    expect(hasSubscriptionDetails(ollamaCloud)).toBe(true);
    expect(hasSubscriptionDetails(ollamaLocal)).toBe(false);
    expect(hasSubscriptionDetails(custom)).toBe(false);
  });

  it('renders Copilot connection metadata without exposing stored credentials', () => {
    const copilot = record('copilot', {
      githubHost: 'github.com',
      user: { id: '123', login: 'octocat', name: 'Octo Cat' },
      githubToken: 'github-secret',
      githubTokenSet: true,
    }) as Extract<UpstreamRecord, { kind: 'copilot' }>;

    renderInApp(<MemoryRouter><SubscriptionUpstreamDetailsPage initialRecord={copilot} /></MemoryRouter>);

    expect(screen.getByText('Connection and authentication')).toBeTruthy();
    expect(screen.getByText('https://api.githubcopilot.com')).toBeTruthy();
    expect(screen.getByText('Octo Cat · octocat')).toBeTruthy();
    expect(screen.getByText('Credential configured')).toBeTruthy();
    expect(screen.queryByText('github-secret')).toBeNull();
    expect(screen.queryByText('session-secret')).toBeNull();
  });

  it('omits URL credentials and query parameters from Ollama Cloud endpoint details', () => {
    const ollama = record('ollama', {
      baseUrl: 'https://operator:password@ollama.example.test/v1?api_key=query-secret',
      apiKey: 'stored-secret',
      apiKeySet: true,
      cloudUsage: true,
      models: [],
    }) as unknown as SubscriptionUpstreamRecord;

    renderInApp(<MemoryRouter><SubscriptionUpstreamDetailsPage initialRecord={ollama} /></MemoryRouter>);

    expect(screen.getAllByText('https://ollama.example.test/v1')).toHaveLength(2);
    expect(screen.queryByText(/operator|password|query-secret|stored-secret/)).toBeNull();
  });
});
