// Antigravity (Google Cloud Code subscription) provider package. OAuth
// bearer auth against `{daily-,}cloudcode-pa.googleapis.com/v1internal`,
// Gemini generateContent payloads wrapped in the Cloud Code envelope.

import { ANTIGRAVITY_DEFAULT_FLAGS } from './defaults.ts';
import { createAntigravityProvider } from './provider.ts';
import type { ProviderModule } from '@floway-dev/provider';

export const antigravityProviderModule: ProviderModule = {
  create: createAntigravityProvider,
  defaultFlags: ANTIGRAVITY_DEFAULT_FLAGS,
};

export { createAntigravityProvider } from './provider.ts';
export { assertAntigravityUpstreamRecord, type AntigravityAccountIdentity, type AntigravityUpstreamConfig, type AntigravityUpstreamRecord } from './config.ts';
export { assertAntigravityUpstreamState, readAntigravityUpstreamState, replaceSoleAccount, type AntigravityAccountCredential, type AntigravityUpstreamState } from './state.ts';
export { ensureAntigravityAccessToken, invalidateAntigravityAccessToken, type EnsuredAntigravityAccessToken } from './access-token.ts';
export { AntigravityOAuthSessionTerminatedError, buildAntigravityAuthorizeUrl, exchangeAntigravityAuthorizationCode, refreshAntigravityAccessToken } from './oauth.ts';
export { probeCloudCodeProject, onboardCloudCodeUser, ensureAntigravityProjectId } from './project.ts';
export { fetchAntigravityAccountEmail, importAntigravityFromCallback, type AntigravityImportResult } from './import.ts';
export { fetchAntigravityCatalog, mergeAntigravityModels, type AntigravityRawModel } from './fetch-available-models.ts';
export { buildAntigravityEnvelope, unwrapAntigravitySseChunk, syntheticTerminalIfMissing, createAntigravityUnwrapState } from './envelope.ts';
export { parseAntigravityStream, type ParseAntigravityStreamOptions } from './stream.ts';
export { antigravityShortUserAgent, antigravityLongUserAgent } from './version.ts';
export { pricingForAntigravityModelId } from './pricing.ts';
