import type { ModelAliasRecord } from '../repo/types.ts';
import type { AliasRules } from '@floway-dev/protocols/common';

export const MAX_ALIAS_DEPTH = 64;
export const MAX_ALIAS_EXPANSION_STEPS = 4096;

export class ModelAliasGraphError extends Error {
  constructor(message: string, readonly aliasChain: readonly string[]) {
    super(message);
    this.name = 'ModelAliasGraphError';
  }
}

export interface ExpandedAliasTarget {
  targetModelId: string;
  rules: AliasRules;
}

export const mergeAliasRules = (outer: AliasRules, inner: AliasRules): AliasRules => {
  const { reasoning: outerReasoning, ...outerFields } = outer;
  const { reasoning: innerReasoning, ...innerFields } = inner;
  const reasoning = { ...outerReasoning, ...innerReasoning };
  return {
    ...outerFields,
    ...innerFields,
    ...(Object.keys(reasoning).length > 0 ? { reasoning } : {}),
  };
};

export const findAliasGraphError = (
  root: ModelAliasRecord,
  aliasesByName: ReadonlyMap<string, ModelAliasRecord>,
): ModelAliasGraphError | null => {
  const state = new Map<string, 'visiting' | 'visited'>();
  const path: string[] = [];
  let steps = 0;

  const visit = (alias: ModelAliasRecord): ModelAliasGraphError | null => {
    const knownState = state.get(alias.name);
    if (knownState === 'visited') return null;
    if (knownState === 'visiting') {
      const cycleStart = path.indexOf(alias.name);
      const cycle = [...path.slice(cycleStart), alias.name];
      return new ModelAliasGraphError(`Model alias cycle detected: ${cycle.join(' -> ')}`, cycle);
    }
    if (path.length >= MAX_ALIAS_DEPTH) {
      const chain = [...path, alias.name];
      return new ModelAliasGraphError(`Model alias nesting exceeds ${MAX_ALIAS_DEPTH} aliases: ${chain.join(' -> ')}`, chain);
    }

    state.set(alias.name, 'visiting');
    path.push(alias.name);
    for (const target of alias.targets) {
      steps++;
      if (steps > MAX_ALIAS_EXPANSION_STEPS) {
        const chain = [...path, target.target_model_id];
        return new ModelAliasGraphError(`Model alias graph exceeds ${MAX_ALIAS_EXPANSION_STEPS} targets: ${chain.join(' -> ')}`, chain);
      }
      const child = aliasesByName.get(target.target_model_id);
      if (child) {
        const error = visit(child);
        if (error) return error;
      }
    }
    path.pop();
    state.set(alias.name, 'visited');
    return null;
  };

  return visit(root);
};

export const expandAliasTargets = (
  root: ModelAliasRecord,
  aliasesByName: ReadonlyMap<string, ModelAliasRecord>,
  orderTargets: (alias: ModelAliasRecord) => readonly ModelAliasRecord['targets'][number][],
): ExpandedAliasTarget[] => {
  const expanded: ExpandedAliasTarget[] = [];
  let steps = 0;

  const visit = (alias: ModelAliasRecord, inheritedRules: AliasRules, path: readonly string[]): void => {
    const cycleStart = path.indexOf(alias.name);
    if (cycleStart !== -1) {
      const cycle = [...path.slice(cycleStart), alias.name];
      throw new ModelAliasGraphError(`Model alias cycle detected: ${cycle.join(' -> ')}`, cycle);
    }
    if (path.length >= MAX_ALIAS_DEPTH) {
      const chain = [...path, alias.name];
      throw new ModelAliasGraphError(`Model alias nesting exceeds ${MAX_ALIAS_DEPTH} aliases: ${chain.join(' -> ')}`, chain);
    }

    const nextPath = [...path, alias.name];
    for (const target of orderTargets(alias)) {
      steps++;
      if (steps > MAX_ALIAS_EXPANSION_STEPS) {
        const chain = [...nextPath, target.target_model_id];
        throw new ModelAliasGraphError(`Model alias graph exceeds ${MAX_ALIAS_EXPANSION_STEPS} targets: ${chain.join(' -> ')}`, chain);
      }
      const rules = mergeAliasRules(inheritedRules, target.rules);
      const child = aliasesByName.get(target.target_model_id);
      if (child) visit(child, rules, nextPath);
      else expanded.push({ targetModelId: target.target_model_id, rules });
    }
  };

  visit(root, {}, []);
  return expanded;
};
