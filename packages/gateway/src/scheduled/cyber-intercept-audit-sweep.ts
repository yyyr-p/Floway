// TTL sweep for the cyber-intercept audit log. Unlike the per-API-key
// expiration domains (dumps, OpenAI Responses), the audit log is one global
// queue: retention lives in the global settings document
// (`auditLogRetentionSeconds`, null = keep forever), so there is no
// expiration_sweeps key to claim — each maintenance tick drains a fixed
// batch oldest-first and only reports work left to do.
import { getRepo } from '../repo/index.ts';
import { loadCyberInterceptSettings } from '../data-plane/chat/shared/cyber-intercept/settings.ts';

const DELETE_BATCH_SIZE = 100;

export const sweepCyberInterceptAuditLog = async (now: number): Promise<void> => {
  const settings = await loadCyberInterceptSettings();
  if (settings.auditLogRetentionSeconds === null) return;
  const cutoffIso = new Date(now - settings.auditLogRetentionSeconds * 1000).toISOString();
  for (;;) {
    const deleted = await getRepo().cyberInterceptAuditLog.deleteExpired(cutoffIso, DELETE_BATCH_SIZE);
    if (deleted < DELETE_BATCH_SIZE) break;
  }
};