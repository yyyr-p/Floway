// Data-plane User-Agent for Antigravity. Cloud Code rejects clients below
// 2.9.0, and the real client stamps `antigravity/hub/<version> <platform>`.
// The version nominally rides the Antigravity IDE's auto-update manifest —
// an electron-builder `latest-arm64-mac.yml` Google publishes at
//   https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml
// (polling wiring described in
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/misc/antigravity_version.go )
// — but polling it from the gateway adds a moving part for a value that only
// gates a floor check upstream, so Floway pins the fallback version as a
// constant and lets an operator override it through the upstream config if
// Google starts enforcing newer ids.

import { ANTIGRAVITY_FALLBACK_CLIENT_VERSION, ANTIGRAVITY_USER_AGENT_PLATFORM } from './constants.ts';

export const antigravityShortUserAgent = (version: string = ANTIGRAVITY_FALLBACK_CLIENT_VERSION): string =>
  `antigravity/hub/${version} ${ANTIGRAVITY_USER_AGENT_PLATFORM}`;

// The long UA the onboardUser call carries — the short form plus the
// google-api-nodejs-client trailer the real client's transport stamps.
// https://github.com/router-for-me/CLIProxyAPI/blob/main/sdk/auth/antigravity.go
export const antigravityLongUserAgent = (version: string = ANTIGRAVITY_FALLBACK_CLIENT_VERSION): string =>
  `${antigravityShortUserAgent(version)} google-api-nodejs-client/10.3.0`;
