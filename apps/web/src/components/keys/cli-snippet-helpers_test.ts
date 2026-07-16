import { describe, expect, it } from 'vitest';

import {
  addCtxSuffix, claudeTier, computeContextById, partition, sortByTierDistance, sortCodex,
} from './cli-snippet-helpers.ts';
import { buildAliasModel, buildRealModel } from '../../api/test-fixtures.ts';

describe('claudeTier', () => {
  it('returns the tier index for canonical claude-* ids', () => {
    expect(claudeTier('claude-fable-1')).toBe(0);
    expect(claudeTier('claude-opus-4-8')).toBe(1);
    expect(claudeTier('claude-sonnet-4-5')).toBe(2);
    expect(claudeTier('claude-haiku-4-5')).toBe(3);
  });

  it('accepts a vendor prefix on the claude-* id', () => {
    expect(claudeTier('vendor/claude-opus-4-8')).toBe(1);
  });

  it('returns 99 for a non-claude id even when its name embeds a tier token', () => {
    // Guards against `vendor/gpt-4-opus-finetune` sneaking into the Opus slot
    // via the reversed-localeCompare tiebreak in sortByTierDistance.
    expect(claudeTier('vendor/gpt-4-opus-finetune')).toBe(99);
    expect(claudeTier('gpt-5')).toBe(99);
    expect(claudeTier('openai/haiku-experiment')).toBe(99);
  });

  it('returns 99 for a claude-* id that names no tier token', () => {
    expect(claudeTier('claude-experimental')).toBe(99);
  });
});

describe('sortByTierDistance', () => {
  it('puts the exact-tier claude id first and sinks non-claude tokenized ids', () => {
    const pool = ['claude-sonnet-4-5', 'vendor/gpt-4-opus-finetune', 'claude-opus-4-8'];
    expect([...pool].sort(sortByTierDistance('opus'))).toEqual([
      'claude-opus-4-8',
      'claude-sonnet-4-5',
      'vendor/gpt-4-opus-finetune',
    ]);
  });

  it('breaks distance ties by reverse localeCompare (newer-looking ids win)', () => {
    const pool = ['claude-opus-4-8', 'claude-opus-4-1'];
    expect([...pool].sort(sortByTierDistance('opus'))).toEqual(['claude-opus-4-8', 'claude-opus-4-1']);
  });
});

describe('sortCodex', () => {
  it('ranks gpt-5* first, then non-mini, then reverse localeCompare', () => {
    const pool = ['gpt-5-mini', 'claude-opus-4-8', 'gpt-5-codex', 'gpt-4o'];
    expect([...pool].sort(sortCodex)).toEqual(['gpt-5-codex', 'gpt-5-mini', 'gpt-4o', 'claude-opus-4-8']);
  });

  it('accepts a vendor prefix on gpt-5', () => {
    const pool = ['vendor/gpt-5', 'claude-opus-4-8'];
    expect([...pool].sort(sortCodex)).toEqual(['vendor/gpt-5', 'claude-opus-4-8']);
  });
});

describe('partition', () => {
  it('splits ids by regex match while preserving input order in each bucket', () => {
    const ids = ['claude-opus-4-8', 'gpt-4o', 'claude-haiku-4-5', 'vendor/gpt-4'];
    expect(partition(ids, /(^|\/)claude-/)).toEqual({
      matched: ['claude-opus-4-8', 'claude-haiku-4-5'],
      other: ['gpt-4o', 'vendor/gpt-4'],
    });
  });
});

describe('computeContextById', () => {
  it('reads max_context_window_tokens when the upstream advertises it', () => {
    const map = computeContextById([
      buildRealModel({ id: 'claude-opus-4-8', limits: { max_context_window_tokens: 1_000_000 } }),
    ]);
    expect(map.get('claude-opus-4-8')).toBe(1_000_000);
  });

  it('falls back to max_prompt_tokens + max_output_tokens when the window is not declared', () => {
    const map = computeContextById([
      buildRealModel({ id: 'gpt-4o', limits: { max_prompt_tokens: 128_000, max_output_tokens: 16_000 } }),
    ]);
    expect(map.get('gpt-4o')).toBe(144_000);
  });

  it('is family-agnostic — non-claude ids are indexed too', () => {
    const map = computeContextById([
      buildRealModel({ id: 'gpt-4.1', limits: { max_context_window_tokens: 1_000_000 } }),
    ]);
    expect(map.get('gpt-4.1')).toBe(1_000_000);
  });

  it('skips non-chat kinds', () => {
    const map = computeContextById([
      buildRealModel({ id: 'text-embedding-3', kind: 'embedding', endpoints: { embeddings: {} }, limits: { max_context_window_tokens: 8_192 } }),
    ]);
    expect(map.has('text-embedding-3')).toBe(false);
  });

  it('indexes alias-kind chat models the same as real chat models', () => {
    const map = computeContextById([
      buildAliasModel({ id: 'default-sonnet', limits: { max_context_window_tokens: 200_000 } }),
    ]);
    expect(map.get('default-sonnet')).toBe(200_000);
  });
});

describe('addCtxSuffix', () => {
  const contextById = new Map<string, number>([
    ['claude-sonnet-4-5', 1_000_000],
    ['claude-opus-4-8', 200_000],
    ['gpt-4.1', 1_000_000],
  ]);

  it('appends [1m] when the context window is at least 1M tokens', () => {
    expect(addCtxSuffix('claude-sonnet-4-5', contextById)).toBe('claude-sonnet-4-5[1m]');
  });

  it('appends [1m] to non-claude ids too — the suffix is family-agnostic', () => {
    expect(addCtxSuffix('gpt-4.1', contextById)).toBe('gpt-4.1[1m]');
  });

  it('leaves the id untouched when the context window is below 1M', () => {
    expect(addCtxSuffix('claude-opus-4-8', contextById)).toBe('claude-opus-4-8');
  });

  it('leaves the id untouched when the id is unknown to the map', () => {
    expect(addCtxSuffix('unknown-model', contextById)).toBe('unknown-model');
  });
});
