import { AffinityCodec, type AffinityIdentity } from './carrier.ts';
import { resolveLegacyOpaqueBlobCompatibilityIdentity } from './legacy.ts';
import { compatibilityIdentityForCandidate, selectAffinityCandidates, type AffinityRequestAnalysis } from './selection.ts';
import { getRepo } from '../../../../repo/index.ts';
import type { ConversationRoute } from '../../../../repo/types.ts';
import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import type { ChatGatewayCtx } from '../gateway-ctx.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface AffinityEgressOptions {
  readonly codec: Pick<AffinityCodec, 'wrap'>;
  readonly affinity: AffinityIdentity;
  readonly onSuccess?: () => Promise<void>;
}

const affinityIdentityForCandidate = (candidate: ModelCandidate): AffinityIdentity => ({
  upstreamId: candidate.provider.upstreamId,
  modelId: candidate.model.id,
  ...(candidate.rules !== undefined ? { rules: candidate.rules } : {}),
  opaqueBlobCompatibilityIdentity: compatibilityIdentityForCandidate(candidate),
});

export class AffinityRequestContext {
  readonly codec: AffinityCodec;
  #selectedCandidate: ModelCandidate | undefined;
  #scope: string | undefined;
  #committed = false;
  #clientSessionId: string | undefined;

  constructor(serverSecret: string, private readonly session?: { apiKeyId: string; id?: string }) {
    this.codec = new AffinityCodec(serverSecret, resolveLegacyOpaqueBlobCompatibilityIdentity);
    this.#clientSessionId = session?.id;
  }

  identifySession(id: string): void {
    this.#clientSessionId = id;
  }

  async candidates<T>(model: string, candidates: readonly ModelCandidate[], analysis: AffinityRequestAnalysis<T>, snapshotRoute?: ConversationRoute) {
    const alias = candidates[0]?.aliasRouting;
    this.#scope = alias === undefined ? `model:${model}` : `alias:${alias.id}`;
    const binding = this.session === undefined || this.#clientSessionId === undefined ? null
      : await getRepo().conversationRoutes.lookup(this.session.apiKeyId, this.#clientSessionId!, this.#scope);
    return selectAffinityCandidates(candidates, analysis, snapshotRoute ?? binding ?? analysis.latestTarget);
  }

  async commitSuccess(): Promise<void> {
    if (this.#committed) return;
    const target = this.selectedTarget();
    if (this.session !== undefined && this.#clientSessionId !== undefined && this.#scope !== undefined) {
      const { opaqueBlobCompatibilityIdentity: _compatibility, ...route } = target;
      await getRepo().conversationRoutes.bind(this.session.apiKeyId, this.#clientSessionId!, this.#scope, route);
    }
    this.#committed = true;
  }

  select(candidate: ModelCandidate): void {
    this.#selectedCandidate = candidate;
  }

  selectedTarget(): AffinityIdentity {
    if (this.#selectedCandidate === undefined) throw new Error('Affinity target requested before a candidate was selected');
    return affinityIdentityForCandidate(this.#selectedCandidate);
  }
}

export const affinityEgressOptions = (ctx: GatewayCtx): AffinityEgressOptions => {
  if (!('affinity' in ctx)) throw new Error('Chat event result reached responder without affinity context');
  const chatCtx = ctx as ChatGatewayCtx;
  return { codec: chatCtx.affinity.codec, affinity: chatCtx.affinity.selectedTarget(), onSuccess: () => chatCtx.affinity.commitSuccess() };
};
