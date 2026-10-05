import { z } from 'zod';

import { decodeAliasTargets } from './model-alias-codecs.ts';
import type { ConversationRoute, ConversationRoutesRepo } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

const routeSchema = z.object({
  upstreamId: z.string().min(1),
  modelId: z.string().min(1),
  rules: z.record(z.string(), z.unknown()).optional(),
});

export const decodeConversationRoute = (raw: string): ConversationRoute => {
  const parsed = routeSchema.parse(JSON.parse(raw));
  return {
    upstreamId: parsed.upstreamId,
    modelId: parsed.modelId,
    ...(parsed.rules === undefined ? {} : {
      rules: decodeAliasTargets(JSON.stringify([{ target_model_id: parsed.modelId, rules: parsed.rules }]), 'conversation-route')[0].rules,
    }),
  };
};

export class SqlConversationRoutesRepo implements ConversationRoutesRepo {
  constructor(private readonly db: SqlDatabase) {}

  async lookup(apiKeyId: string, sessionId: string, scope: string): Promise<ConversationRoute | null> {
    const row = await this.db.prepare('SELECT route_json FROM conversation_routes WHERE api_key_id = ? AND session_id = ? AND scope = ?')
      .bind(apiKeyId, sessionId, scope).first<{ route_json: string }>();
    return row === null ? null : decodeConversationRoute(row.route_json);
  }

  async bind(apiKeyId: string, sessionId: string, scope: string, route: ConversationRoute): Promise<void> {
    // SQLite serializes successful commits; the last committed success wins.
    await this.db.prepare(`INSERT INTO conversation_routes (api_key_id, session_id, scope, route_json)
      VALUES (?, ?, ?, ?) ON CONFLICT (api_key_id, session_id, scope)
      DO UPDATE SET route_json = excluded.route_json`)
      .bind(apiKeyId, sessionId, scope, JSON.stringify(route)).run();
  }
}
