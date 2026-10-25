<h1 align="center">
  <img src="apps/web/src/assets/floway-blue.svg" alt="Floway logo" width="120" height="120"><br>
  Floway
</h1>

Floway is a self-hosted LLM API gateway for coding agents and API clients, with
a web dashboard. It connects GitHub Copilot, ChatGPT, Claude.ai, Azure AI,
custom HTTP providers, and Ollama through OpenAI, Anthropic, and
Gemini-compatible APIs.

## Deployment

### Cloudflare Workers

Ask your agent or follow the
[$deploy-to-cloudflare](.agents/skills/deploy-to-cloudflare/SKILL.md) skill yourself
to configure and deploy Floway to your Cloudflare account.

### Docker

```bash
git clone https://github.com/Menci/Floway.git
cd Floway
ADMIN_KEY='replace-with-a-secret' docker compose -f docker/docker-compose.yml up --build -d
```

Open <http://localhost:8788>, leave the username blank, and log in with
`ADMIN_KEY`. Data persists in the `floway-data` volume.

### Podman/systemd

Ask your agent or follow the [deployment guide](docker/systemd/README.md) yourself
to run Floway as a systemd service with Podman.

## Usage

Add an upstream under **Providers → Upstreams**, then create a key under
**Services → API Keys**. Use the API key in your client code or configure your
agents to use Floway as provider through **Agent Setup**.

## OAuth2 Dashboard Login

Floway can offer one or more custom OAuth2 providers alongside password and
`ADMIN_KEY` login. A provider-authenticated identity that is not bound yet can
choose a Floway username and register itself; the new non-admin user receives a
default API key. Later logins resolve the stable provider user ID back to that
same Floway account.

Register this callback URL in the OAuth2 application, replacing the origin and
provider ID with your values:

```text
https://floway.example.com/auth/oauth2/company/callback
```

Sign in as an administrator and open **Management → OAuth2 Login**. Set the
externally visible Floway origin (scheme, host, and optional port, without a
path), then add a provider. Floway displays the exact callback URL to register
with the OAuth2 application. Use HTTPS outside local development.

Each provider requires an ID, display name, client ID, client secret, and the
authorization, token, and UserInfo endpoint URLs. The remaining controls are:

- `clientAuthentication`: `client_secret_post` (the default) or
  `client_secret_basic`.
- `scopes`: scopes sent with the authorization request.
- `userIdClaim`: userinfo claim containing the immutable account ID; defaults
  to the first of `sub`, `id`, or `user_id`.
- `usernameClaim`: userinfo claim used as the registration display/login hint;
  defaults through common username, name, and email claims.
- `authorizationParams`: extra string parameters for the authorization
  endpoint. Protocol-owned parameters such as `state`, `redirect_uri`, and the
  PKCE challenge cannot be overridden.

Claim names may be dotted paths such as `data.user.id`. Provider client secrets
are stored in the Floway database and backup export, but are never returned by
the management API or hydrated back into the dashboard form. Authorization
state and browser binding are single-use and short-lived, PKCE uses S256, and
callback handoffs travel in the URL fragment so reverse proxies and static
asset servers do not receive them.

The optional UserInfo access policy is evaluated against the provider's raw
UserInfo JSON on every login and new account binding. Leave the policy editor
blank to permit every authenticated user. A policy combines conditions with
`and` or `or`, and `field` is a dotted JSON path such as `profile.roles`:

```json
{
  "logic": "or",
  "conditions": [
    { "field": "groups", "op": "contains", "value": "company:owners" },
    { "field": "groups", "op": "contains", "value": "company:buildbot" }
  ]
}
```

The provider must request whatever scope causes the upstream to include those
claims, such as `groups`; Floway does not call vendor-specific membership APIs.

The supported operators are:

- `eq` and `ne`: strict JSON equality without type conversion.
- `gt`, `gte`, `lt`, and `lte`: ordering between two numbers or two strings.
- `in` and `not_in`: strict membership of the claim value in the configured
  `value` array.
- `contains` and `not_contains`: strict member matching for an array claim, or
  substring matching when both the claim and configured value are strings.
- `exists` and `not_exists`: whether the dotted field path is present. These
  conditions omit `value`; a present `null` value still counts as existing.

Missing fields and values of incompatible types do not satisfy binary
operators, including negative operators. An empty `and` policy permits every
user, while an empty `or` policy rejects every user.

Each provider can define the message displayed when its policy rejects an
account. The template supports `{{provider}}`, `{{field}}`, `{{op}}`,
`{{required}}`, and `{{current}}`. Dotted paths under `current`, such as
`{{current.roles}}`, read individual claims from the complete UserInfo object.
Unknown variables remain unchanged. Leave the message blank to use Floway's
default error.

The self-registration upstream control optionally restricts initial `Model.Use`
permissions for accounts created through that provider. Turning the override off
grants `Model.Use` on all upstreams; turning it on grants `Model.Use` only on the
selected upstreams and sets the same allowlist on the new user's default API key.
The selection is captured when the OAuth2 callback succeeds, so a registration
already in progress keeps the permissions it was offered. It affects only new
users and does not rewrite existing accounts.

Signed-in users manage their own OAuth2 bindings under **Settings → OAuth2
Accounts**. An account with no password must keep at least one OAuth2 binding;
it can bind another enabled provider first and then remove the old binding.
Administrators can inspect and unlink the same identities while editing a user.

## Development

```bash
pnpm install
pnpm run dev:node
```

## License

MIT
