# Floway Usage Passthrough

Status: proposal only. This change adds no route, provider, or UI behavior.

## Existing Boundaries

- `/api/token-usage?view=self-by-key` is user-scoped: it aggregates every key owned by the authenticated user. `/api/usage-limits` is inside the admin-only route group and returns all users, keys, and limits. Neither is a safe wire contract for a remote custom upstream (`packages/gateway/src/control-plane/token-usage/routes.ts`, `packages/gateway/src/control-plane/usage-limits/routes.ts`).
- The custom upstream probe accepts configured JSON Pointers and projects numeric `used`/`limit` windows. It bounds responses to 64 KiB, rejects redirects, and returns no raw response body. Its editor card keeps the last successful reading when refresh fails (`packages/provider-custom/src/usage-probe.ts`, `apps/web/src/components/upstream-editor/custom-management-editor.tsx`).
- Custom probe management routes are admin-only. The ordinary-user upstream directory is an allowlisted identity summary; full upstream detail is admin-only. Custom upstream usage is not currently shown in the general upstream signal list (`packages/gateway/src/control-plane/routes.ts`, `packages/gateway/src/control-plane/upstreams/routes.ts`, `apps/web/src/components/upstreams/signals.tsx`).

## Proposed Contract

Add `GET /api/v1/usage-snapshot`, authenticated by a normal Floway API key. Require that the key belongs to a non-admin user; reject session credentials and admin-owned keys. Use a dedicated non-admin service user/key for a remote Floway custom upstream. Never accept or forward `ADMIN_KEY`, dashboard sessions, or another instance's administrator credential.

Version 1 reports only local accounting for the exact presented API key. It reads local usage and key-level limits; it does not aggregate sibling keys, user-wide limits, or any provider subscription quota. Do not return key/user IDs or names, upstream/account metadata, secrets, or the administrator usage DTO.

Candidate response shape:

```json
{
  "schemaVersion": 1,
  "scope": "presented-key",
  "observedAt": "2026-10-05T12:00:00.000Z",
  "windows": {
    "hour": { "start": "2026-10-05T11:00:00Z", "end": "2026-10-05T12:00:00Z", "usedTokens": 12, "maxTokens": null, "usedCostUsd": "0.000120", "maxCostUsd": null },
    "day": { "start": "2026-10-05T00:00:00Z", "end": "2026-10-06T00:00:00Z", "usedTokens": 12, "maxTokens": 1000, "usedCostUsd": null, "maxCostUsd": "1.00" },
    "month": { "start": "2026-10-01T00:00:00Z", "end": "2026-11-01T00:00:00Z", "usedTokens": 12, "maxTokens": 10000, "usedCostUsd": "0.000120", "maxCostUsd": "10.00" }
  }
}
```

Use UTC windows, decimal strings for USD, `null` for an unset limit, and `null` usage cost when any included usage is unpriced. Keep additive changes within `schemaVersion: 1`; make incompatible changes at a new versioned path. A successful empty period reports zero usage, while storage or calculation failure returns an error rather than fabricated zeros.

This endpoint is a local snapshot, not "the upstream subscription quota." A Floway provider's Copilot/Codex/Claude subscription allowance is owned by that provider account and remains a separate signal. Likewise, omit user-wide limits in v1: they cover sibling keys and are not the presented key's budget. If either is needed, define a separately named scope and authorization rule.

The handler must query local repositories only. It must not probe configured upstreams or request another Floway snapshot, so an A -> B -> C chain remains single-hop and cannot recurse. Show each configured Floway source separately; do not sum sources, since keys may overlap or represent the same local traffic.

## Consumer And Visibility

The custom usage probe is a plausible consumer, but its current `used` and `limit` fields require numbers and represent one scalar per configured window. It cannot faithfully express nullable limits, unpriced cost, and both token and USD budgets together. Before implementation, choose a typed Floway projection in the custom management card or extend the generic probe and its display model; do not coerce `null` to zero.

Keep snapshots out of `/api/upstream-directory`, which is deliberately identity-only. Default to admin-only display. If ordinary users should see remote usage, gate it through an explicit `userVisible` policy and a separate allowlisted projection; never expose the stored custom config or raw remote payload. On fetch or parse failure, preserve the last successful reading with its timestamp and show the error.

Other gateway designs reinforce the need to choose scope explicitly: [a Copilot proxy](https://github.com/voidsteed/copilot-proxy-api) documents broad `/usage` and `/token` monitoring routes, while [another Copilot gateway](https://github.com/abhi-singhs/copilot-api-gateway) defaults to a local master key and explicitly omits budgets and virtual keys. [LiteLLM's spend tracking](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/cost_tracking.md) distinguishes caller-scoped key/user data from admin-wide views. These are comparisons, not a contract to copy.

## Decisions Before Implementation

1. Select the intended data: the presented key's local usage/limits (recommended), the owning user's aggregate, or the provider account's subscription quota. These have different owners and disclosure boundaries; v1 above chooses the first.
2. Decide whether ordinary users may view the snapshot. The proposal defaults to admin-only and keeps the existing identity-only directory unchanged.
3. Decide whether multiple Floway upstreams are ever aggregated. The proposal keeps each source separate.

## Verification Plan

Test exact-key isolation, rejection of sessions/admin-owned keys, omission of identifiers and provider metadata, nullable/unpriced fields, UTC boundaries, repository error propagation, and a non-recursive chain. Test the custom consumer against the versioned fixture, including failed refresh retaining the last success, then run the owning gateway/web tests and root verifiers.
