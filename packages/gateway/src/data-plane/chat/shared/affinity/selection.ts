import { isEqual } from 'es-toolkit';

import { affinityIdentityOf, type AffinityIdentity, type AffinityTarget, type DecodedAffinityBlob, type OpaqueBlobCompatibilityIdentity } from './carrier.ts';
import type { ChatServeFailure } from '../errors.ts';
import { materializeOpaqueBlobCompatibilityIdentity } from '@floway-dev/protocols/common';
import { providerModelOf, type ModelCandidate } from '@floway-dev/provider';

export interface AffinityRoutingHistory {
  readonly latestTarget?: AffinityTarget;
  readonly latestOpaqueTarget?: AffinityIdentity;
}

export const analyzeAffinityRoutingHistory = (blobs: readonly DecodedAffinityBlob[]): AffinityRoutingHistory => {
  const latest = blobs.findLast(blob => blob.kind === 'owned');
  const opaque = blobs.findLast(blob => blob.kind === 'owned' && blob.value !== undefined);
  return {
    latestTarget: latest?.kind === 'owned' ? latest.affinity : undefined,
    latestOpaqueTarget: opaque?.kind === 'owned' ? affinityIdentityOf(opaque) : undefined,
  };
};

export interface AffinityRequestAnalysis<T> extends AffinityRoutingHistory {
  readonly requiredTargets: readonly AffinityIdentity[];
  readonly evaluateCandidate: (candidate: ModelCandidate) => CandidateAffinityEvaluation<T>;
}

export type CandidateAffinityEvaluation<T> =
  | { readonly kind: 'rejected' }
  | { readonly kind: 'accepted'; readonly degrades: boolean; readonly preferred?: boolean; readonly materialize: () => T };

export interface AffinityCandidateSelection<T> {
  readonly candidates: readonly ModelCandidate[];
  readonly payloadFor: (candidate: ModelCandidate) => T;
}

export type AffinitySelectionFailure = Extract<ChatServeFailure, { kind: 'routing-unavailable' }>;

export type OptionalAffinityBlobProjection =
  | { readonly kind: 'preserve'; readonly value: string; readonly preferred: boolean }
  | { readonly kind: 'remove'; readonly degrades: boolean; readonly preferred: boolean };

export type RequiredAffinityBlobProjection =
  | OptionalAffinityBlobProjection
  | { readonly kind: 'reject'; readonly requiredTarget: AffinityIdentity };

const sameCompatibilityIdentity = (
  left: OpaqueBlobCompatibilityIdentity,
  right: OpaqueBlobCompatibilityIdentity,
): boolean => left.upstreamId === right.upstreamId && left.key === right.key;

const candidateMatchesExactTarget = (candidate: ModelCandidate, affinity: AffinityTarget): boolean =>
  candidate.provider.upstreamId === affinity.upstreamId
  && candidate.model.id === affinity.modelId
  // Alias targets always carry a rules object, while direct candidates omit
  // it. Both shapes describe the same no-overlay variant when the object is
  // empty, which lets a pre-alias session follow its real binding after a
  // same-name alias starts shadowing that model.
  && isEqual(candidate.rules ?? {}, affinity.rules ?? {});

const candidateMatchesPhysicalTarget = (candidate: ModelCandidate, affinity: AffinityTarget): boolean =>
  candidate.provider.upstreamId === affinity.upstreamId && candidate.model.id === affinity.modelId;

export const compatibilityIdentityForCandidate = (candidate: ModelCandidate): OpaqueBlobCompatibilityIdentity => {
  const model = providerModelOf(candidate);
  return materializeOpaqueBlobCompatibilityIdentity(
    model.opaqueBlobCompatibilityScope,
    candidate.provider.upstreamId,
    model.upstreamModelId,
  );
};

export const candidateSatisfiesAffinityIdentity = (candidate: ModelCandidate, target: AffinityIdentity): boolean =>
  sameCompatibilityIdentity(compatibilityIdentityForCandidate(candidate), target.opaqueBlobCompatibilityIdentity);

export const projectOptionalAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: ModelCandidate,
): OptionalAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value, preferred: true };
  const target = {
    ...decoded.affinity,
    opaqueBlobCompatibilityIdentity: decoded.opaqueBlobCompatibilityIdentity,
  };
  const compatible = candidateSatisfiesAffinityIdentity(candidate, target);
  const preferred = compatible && candidateMatchesExactTarget(candidate, decoded.affinity);
  if (!compatible || decoded.value === undefined) {
    return { kind: 'remove', degrades: decoded.value !== undefined, preferred };
  }
  return { kind: 'preserve', value: decoded.value, preferred };
};

export const projectRequiredAffinityBlob = (
  decoded: DecodedAffinityBlob,
  candidate: ModelCandidate,
): RequiredAffinityBlobProjection => {
  if (decoded.kind === 'foreign') return { kind: 'preserve', value: decoded.value, preferred: true };
  const target = {
    ...decoded.affinity,
    opaqueBlobCompatibilityIdentity: decoded.opaqueBlobCompatibilityIdentity,
  };
  if (!candidateSatisfiesAffinityIdentity(candidate, target)) return { kind: 'reject', requiredTarget: target };
  const preferred = candidateMatchesPhysicalTarget(candidate, decoded.affinity);
  if (decoded.value === undefined) return { kind: 'remove', degrades: false, preferred };
  return { kind: 'preserve', value: decoded.value, preferred };
};

export const defineAffinityRequest = <T>(
  requiredTargets: readonly AffinityIdentity[],
  evaluate: (candidate: ModelCandidate) => CandidateAffinityEvaluation<T>,
  history: AffinityRoutingHistory = {},
): AffinityRequestAnalysis<T> => {
  const uniqueRequiredTargets: AffinityIdentity[] = [];
  for (const target of requiredTargets) {
    if (!uniqueRequiredTargets.some(existing => sameCompatibilityIdentity(
      existing.opaqueBlobCompatibilityIdentity,
      target.opaqueBlobCompatibilityIdentity,
    ))) uniqueRequiredTargets.push(target);
  }
  const evaluations = new WeakMap<ModelCandidate, CandidateAffinityEvaluation<T>>();
  return {
    ...history,
    requiredTargets: uniqueRequiredTargets,
    evaluateCandidate: candidate => {
      const existing = evaluations.get(candidate);
      if (existing !== undefined) return existing;
      const candidateEvaluation = evaluate(candidate);
      const satisfiesRequirements = uniqueRequiredTargets.every(target => candidateSatisfiesAffinityIdentity(candidate, target));
      if ((candidateEvaluation.kind === 'accepted') !== satisfiesRequirements) {
        throw new Error('Affinity candidate evaluation disagrees with the request requirement analysis');
      }
      if (candidateEvaluation.kind === 'rejected') {
        evaluations.set(candidate, candidateEvaluation);
        return candidateEvaluation;
      }
      let materialized: { readonly value: T } | undefined;
      const accepted: CandidateAffinityEvaluation<T> = {
        kind: 'accepted',
        degrades: candidateEvaluation.degrades,
        preferred: candidateEvaluation.preferred !== false,
        materialize: () => {
          materialized ??= { value: candidateEvaluation.materialize() };
          return materialized.value;
        },
      };
      evaluations.set(candidate, accepted);
      return accepted;
    },
  };
};

export const selectAffinityCandidates = <T>(
  candidates: readonly ModelCandidate[],
  affinity: AffinityRequestAnalysis<T>,
  latestTarget: AffinityTarget | undefined = affinity.latestTarget,
): AffinityCandidateSelection<T> | AffinitySelectionFailure => {
  if (affinity.requiredTargets.length > 1) {
    return {
      kind: 'routing-unavailable',
      message: `Client-carried state requires multiple incompatible targets: ${affinity.requiredTargets.map(target => `'${target.upstreamId}/${target.modelId}'`).join(', ')}.`,
    };
  }

  const accepted: Array<{
    readonly candidate: ModelCandidate;
    readonly evaluation: Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }>;
  }> = [];
  for (const candidate of candidates) {
    const evaluation = affinity.evaluateCandidate(candidate);
    if (evaluation.kind === 'accepted') accepted.push({ candidate, evaluation });
  }
  if (affinity.requiredTargets.length === 1 && accepted.length === 0) {
    const [required] = affinity.requiredTargets;
    return {
      kind: 'routing-unavailable',
      message: `Client-carried state requires unavailable target '${required.upstreamId}/${required.modelId}'.`,
    };
  }

  const rank = (item: typeof accepted[number]): number => {
    const losesLatestOpaque = affinity.latestOpaqueTarget !== undefined
      && !candidateSatisfiesAffinityIdentity(item.candidate, affinity.latestOpaqueTarget);
    return (losesLatestOpaque ? 2 : 0) + (item.evaluation.degrades ? 1 : 0);
  };
  const ordered = [...accepted].sort((left, right) => {
    const leftLast = latestTarget !== undefined && candidateMatchesExactTarget(left.candidate, latestTarget);
    const rightLast = latestTarget !== undefined && candidateMatchesExactTarget(right.candidate, latestTarget);
    if (leftLast !== rightLast) return leftLast ? -1 : 1;
    const routing = left.candidate.aliasRouting;
    if (routing !== undefined && !routing.preserveOpaque) {
      const groupDifference = routing.group - right.candidate.aliasRouting!.group;
      if (groupDifference !== 0) return groupDifference;
    }
    return rank(left) - rank(right);
  });
  const evaluations = new WeakMap(ordered.map(item => [item.candidate, item.evaluation]));
  return {
    candidates: ordered.map(item => item.candidate),
    payloadFor: candidate => {
      const evaluation = evaluations.get(candidate);
      if (evaluation === undefined) throw new Error('Affinity payload requested for a candidate outside the selected set');
      return evaluation.materialize();
    },
  };
};
