// Antigravity (Google Cloud Code for IDEs — the Antigravity IDE subscription
// surface) OAuth + data-plane constants. Pinned to the dedicated Google OAuth
// client the Antigravity IDE ships with; the wire constants below follow the
// CLIProxyAPI reverse-engineered implementation:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/antigravity/constants.go
// (client id / secret literal values live there — GitHub push protection
// blocks committing them verbatim, so this file imports them from
// oauth-client.ts, which documents how to recover them from the upstream).
//
// Cloud Code endpoints: https://{daily-,}cloudcode-pa.googleapis.com/v1internal.
// Requests default to the daily host per CLIProxyAPI's executor wiring:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/executor/antigravity_executor_request.go

// The Antigravity-specific Google OAuth client id / secret pair. Literal
// values could not be committed here — GitHub push protection scans Google
// OAuth client identifiers for every push — so they resolve lazily from the
// deployment environment; see oauth-client.ts.

// Standard Google OAuth front doors shared by every first-party client.
// https://developers.google.com/identity/protocols/oauth2/refresher-token
export const ANTIGRAVITY_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Loopback redirect for the installed-app flow. The Antigravity client is
// registered against a fixed port; the headless paste mode reuses it.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/antigravity/constants.go
export const ANTIGRAVITY_CALLBACK_PORT = 51121;
export const ANTIGRAVITY_REDIRECT_URI = `http://localhost:${ANTIGRAVITY_CALLBACK_PORT}/oauth-callback`;

// Scope set the Antigravity IDE requests at sign-in. `cloud-platform`
// authorizes the Cloud Code calls; `userinfo.email` / `userinfo.profile`
// feed the identity fetch; `cclog` and `experimentsandconfigs` are the
// IDE's own telemetry / feature-flag scopes and are requested to keep the
// grant fingerprint identical to the real client.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/antigravity/constants.go
export const ANTIGRAVITY_OAUTH_SCOPE = 'cloud-platform userinfo.email userinfo.profile cclog experimentsandconfigs';

// Identity endpoint the real client hits after token exchange.
// https://www.googleapis.com/oauth2/v2/userinfo?alt=json
export const ANTIGRAVITY_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo?alt=json';

// Data-plane hosts. `dailyCloudCodePaBaseUrl` is the default egress host —
// requests (generateContent / stream / countTokens / fetchAvailableModels)
// go there; loadCodeAssist probes the prod host. Per CLIProxyAPI's wiring:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/executor/antigravity_executor_request.go
export const ANTIGRAVITY_PROD_BASE_URL = 'https://cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_DAILY_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';

// Path family on either host. The `{model|operation}` segment is the v1
// internal verb (`:generateContent` / `:streamGenerateContent?alt=sse` /
// `:countTokens` / `:fetchAvailableModels` / `:loadCodeAssist` /
// `:onboardUser`).
export const ANTIGRAVITY_API_VERSION = 'v1internal';

// User-Agent prefix the Antigravity IDE sends on data-plane calls.
// Format: `antigravity/hub/<version> darwin/arm64` (short form) — see
// version.ts for the version resolution. The long form appends
// ` google-api-nodejs-client/10.3.0` only on the onboardUser call.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/misc/antigravity_version.go
export const ANTIGRAVITY_USER_AGENT_PLATFORM = 'darwin/arm64';

// Companion header constant the real client (a Google API nodejs client
// under the hood) sends, and that onboardUser requires.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go
export const ANTIGRAVITY_X_GOOG_API_CLIENT = 'gl-node/22.21.1';
export const ANTIGRAVITY_GOOGLE_API_NODEJS_CLIENT = 'google-api-nodejs-client/10.3.0';

// Cloud Code rejects clients older than 2.9.0; if the live manifest probe
// fails this floor is used instead.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/misc/antigravity_version.go
export const ANTIGRAVITY_FALLBACK_CLIENT_VERSION = '2.9.1';

// ideType metadata stamped into loadCodeAssist / onboardUser bodies.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go
export const ANTIGRAVITY_IDE_TYPE = 'ANTIGRAVITY';
export const ANTIGRAVITY_IDE_NAME = 'antigravity';

// requestType values on the antigravity envelope. The agent value is the
// chat default; image_gen rides image-model requests.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/translator/antigravity/gemini/antigravity_gemini_request.go
export const ANTIGRAVITY_REQUEST_TYPE_AGENT = 'agent';
