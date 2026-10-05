import { describe, expect, test } from 'vitest';

import { isModelAllowedByUpstreamModelAccess, parseUpstreamModelAccess } from '../../src/repo/model-access.ts';

describe('upstream model access', () => {
  test('no rule and inherit preserve the unrestricted default', () => {
    expect(isModelAllowedByUpstreamModelAccess([], 'u1', 'new-model')).toBe(true);
    expect(isModelAllowedByUpstreamModelAccess([
      { upstreamId: 'u1', mode: 'inherit', modelIds: [] },
    ], 'u1', 'new-model')).toBe(true);
  });

  test('allow is fail-closed for new IDs and deny matches only the selected upstream source ID', () => {
    const allow = [{ upstreamId: 'u1', mode: 'allow' as const, modelIds: ['model-a'] }];
    expect(isModelAllowedByUpstreamModelAccess(allow, 'u1', 'model-a')).toBe(true);
    expect(isModelAllowedByUpstreamModelAccess(allow, 'u1', 'new-model')).toBe(false);
    expect(isModelAllowedByUpstreamModelAccess(allow, 'u2', 'new-model')).toBe(true);

    const deny = [{ upstreamId: 'u1', mode: 'deny' as const, modelIds: ['model-a'] }];
    expect(isModelAllowedByUpstreamModelAccess(deny, 'u1', 'model-a')).toBe(false);
    expect(isModelAllowedByUpstreamModelAccess(deny, 'u1', 'new-model')).toBe(true);
    expect(isModelAllowedByUpstreamModelAccess(deny, 'u2', 'model-a')).toBe(true);
  });

  test('independent user and key rules compose conjunctively regardless of order', () => {
    const userDeny = { upstreamId: 'u1', mode: 'deny' as const, modelIds: ['model-a'] };
    const keyAllow = { upstreamId: 'u1', mode: 'allow' as const, modelIds: ['model-a', 'model-b'] };
    expect(isModelAllowedByUpstreamModelAccess([userDeny, keyAllow], 'u1', 'model-a')).toBe(false);
    expect(isModelAllowedByUpstreamModelAccess([keyAllow, userDeny], 'u1', 'model-a')).toBe(false);
    expect(isModelAllowedByUpstreamModelAccess([userDeny, keyAllow], 'u1', 'model-b')).toBe(true);
  });

  test('stored rules reject duplicate subjects, duplicate models, and malformed inheritance', () => {
    expect(() => parseUpstreamModelAccess([
      { upstreamId: 'u1', mode: 'deny', modelIds: [] },
      { upstreamId: 'u1', mode: 'allow', modelIds: ['model-a'] },
    ], 'test')).toThrow(/duplicate upstream/);
    expect(() => parseUpstreamModelAccess([
      { upstreamId: 'u1', mode: 'allow', modelIds: ['model-a', 'model-a'] },
    ], 'test')).toThrow(/duplicates/);
    expect(() => parseUpstreamModelAccess([
      { upstreamId: 'u1', mode: 'inherit', modelIds: ['model-a'] },
    ], 'test')).toThrow(/inherit rule/);
    expect(() => parseUpstreamModelAccess({ upstreamId: 'u1' }, 'test')).toThrow(/not an array/);
  });
});
