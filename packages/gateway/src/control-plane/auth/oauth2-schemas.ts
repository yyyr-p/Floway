// OAuth2 body schemas, separated from ../schemas.ts so fork's OAuth2 additions
// never share a file with upstream's schema churn. Import targets stay identical
// (routes.ts and auth/oauth2-admin-routes.ts) — only the module path changes.

import { z } from 'zod';

import { oauth2AccessPolicySchema } from './oauth2-config.ts';
import { USERNAME_PATTERN } from '../schemas.ts';

const usernameSchema = z.string().regex(USERNAME_PATTERN, 'username must be 1-64 chars of [A-Za-z0-9_.-]');

const oauth2HandoffTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'invalid OAuth2 handoff token');

export const oauth2ResultBody = z.object({
  token: oauth2HandoffTokenSchema,
});

export const oauth2RegisterBody = z.object({
  registrationToken: oauth2HandoffTokenSchema,
  username: usernameSchema,
});

const oauth2Trimmed = z.string().trim().min(1);
const oauth2RegistrationUpstreamIdsBody = z.array(oauth2Trimmed.max(200))
  .min(1, 'Select at least one upstream, or turn off the override to allow all.')
  .max(100)
  .refine(ids => new Set(ids).size === ids.length, 'registration_upstream_ids contains duplicates')
  .nullable();
const oauth2ProviderFields = {
  display_name: oauth2Trimmed.max(200),
  enabled: z.boolean(),
  client_id: oauth2Trimmed.max(4096),
  authorization_endpoint: oauth2Trimmed.max(4096),
  token_endpoint: oauth2Trimmed.max(4096),
  userinfo_endpoint: oauth2Trimmed.max(4096),
  scopes: z.array(oauth2Trimmed.max(200)).max(100),
  client_authentication: z.enum(['client_secret_post', 'client_secret_basic']),
  user_id_claim: oauth2Trimmed.max(200).nullable(),
  username_claim: oauth2Trimmed.max(200).nullable(),
  authorization_params: z.record(oauth2Trimmed.max(200), z.string().max(4096)),
  access_policy: oauth2AccessPolicySchema,
  access_denied_message: z.string().max(2000),
  registration_upstream_ids: oauth2RegistrationUpstreamIdsBody,
};

export const oauth2SettingsBody = z.object({
  public_base_url: z.string().trim().max(4096),
}).strict();

export const createOAuth2ProviderBody = z.object({
  id: oauth2Trimmed.max(64).regex(/^[A-Za-z0-9_-]+$/, 'id must contain only letters, digits, underscore, or dash'),
  client_secret: oauth2Trimmed.max(4096),
  ...oauth2ProviderFields,
}).strict();

export const updateOAuth2ProviderBody = z.object({
  client_secret: oauth2Trimmed.max(4096).optional(),
  ...oauth2ProviderFields,
}).strict();
