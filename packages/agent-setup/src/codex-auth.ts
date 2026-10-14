// Codex parses ID-token claims locally for account type and plan. This identity
// is deliberately unsigned; the Floway API key authenticates gateway requests.
// https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/login/src/token_data.rs
// https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/protocol/src/auth.rs#L61-L99
const encode = (value: object): string => btoa(JSON.stringify(value)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_');
export const codexSpoofIdToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
  email: 'floway@local',
  'https://api.openai.com/auth': {
    chatgpt_plan_type: 'pro',
    chatgpt_user_id: 'user-floway',
    chatgpt_account_id: 'acct-floway',
  },
})}.c2ln`;

export const buildCodexSpoofAuth = (apiKey: string, lastRefresh: string | null) => ({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: { id_token: codexSpoofIdToken, access_token: apiKey, refresh_token: 'noop' },
  last_refresh: lastRefresh,
});
