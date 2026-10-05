// Antigravity OAuth client credentials. The literal pair is published in the
// upstream reverse-engineered implementation:
//   https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/antigravity/constants.go
// These are the Antigravity IDE's own first-party client credentials — the
// values the desktop app ships with — not a Floway-issued secret, and every
// independent gateway implementing this surface carries an identical copy.
//
// They still cannot live in this repository: GitHub push protection scans
// Google OAuth client identifiers and rejects any push containing them, no
// matter how public their origin. The module therefore reads them from the
// deployment environment and fails loudly with the source pointer when the
// deployment has not configured them. On Cloudflare both values are worker
// secrets; on Node they are plain env vars.

const readClientCredential = (envKey: string, label: string): string => {
  const value = process.env[envKey]?.trim();
  if (value === undefined || value === '') {
    throw new Error(
      `Antigravity OAuth ${label} is not configured. Set the ${envKey} environment variable on the deployment; `
      + `the constants are the Antigravity IDE's public client pair published at `
      + 'https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/antigravity/constants.go',
    );
  }
  return value;
};

// Read lazily (not at module load) so merely importing the package — a test
// collection, a type check — does not demand the env vars; the first OAuth
// operation that actually needs the values is the one that trips the error.
export const antigravityClientId = (): string => readClientCredential('ANTIGRAVITY_OAUTH_CLIENT_ID', 'client id');
export const antigravityClientSecret = (): string => readClientCredential('ANTIGRAVITY_OAUTH_CLIENT_SECRET', 'client secret');
