# Model Alias Regex Routing: Design Note

Status: proposal only. No regex routing is implemented by this change.

## Baseline Semantics

The current exact alias is a uniquely named database row with a kind, an
ordered `targets` array, `selection`, `enabled`, optional request-rule overlays, listing
visibility, and `sort_order` (`packages/protocols/src/common/aliases.ts`,
`packages/gateway/src/control-plane/schemas.ts`, and the model-alias repository).
The data plane calls `getByName(model)` for an exact lookup. Enabled aliases
expand nested alias targets before resolving terminal IDs against real model
catalogs. Inner target rules override outer rules, while reasoning fields
merge individually. Expansion preserves each alias's target-selection policy.
Control-plane writes reject cross-alias cycles; request-time expansion also
detects cycles and caps depth at 64 aliases and work at 4096 target visits.
Same-name targets bind the real model directly, preserving existing aliases
that override a real model under its own ID without recursive lookup.

Disabled aliases do not expand, including when referenced by a parent; their
names can still bind a real model with the same ID. `visible_in_models_list`
only controls catalog listing, so hidden enabled aliases remain addressable
and can serve as nested targets. `sort_order` controls visual/list order and
does not affect exact request dispatch. Model listing computes nested alias
metadata from terminal targets and narrows their projection to the caller's
access, while the admin projection retains the original configuration.

## Evidence From Other Projects

- [Google RE2 README](https://github.com/google/re2/blob/main/README.md) makes
  safety a design goal: match time is linear in input length, parser/compiler
  memory is bounded, and backreferences and look-around are unsupported.
  [RE2 syntax](https://github.com/google/re2/wiki/syntax) supports named and
  numbered captures but not those backtracking-only constructs. This is the
  strongest fit for operator-supplied patterns, subject to proving one engine
  implementation works in both Node and Cloudflare Workers.
- [Cloudflare Workers WebAssembly docs](https://developers.cloudflare.com/workers/runtime-apis/webassembly/)
  allow Wasm, but `WebAssembly.instantiate()` takes precompiled modules; the
  [JavaScript Wasm guide](https://developers.cloudflare.com/workers/runtime-apis/webassembly/javascript/)
  describes importing a bundled Wasm module. A Wasm RE2 port is plausible, not
  yet verified in this repository's Worker build and runtime.
- [CC Switch's Codex model-mapping guide](https://github.com/farion1231/cc-switch/blob/main/docs/user-manual/en/2-providers/2.1-add.md)
  describes explicit concrete model IDs as the source of its `/model` catalog.
  It is a useful routing/catalog comparison, but it documents exact rows, not
  regex matching.
- [LiteLLM virtual-key alias validation](https://github.com/BerriAI/litellm/blob/main/docs/proxy/virtual_keys.md)
  uses whole-string matching, a 255-character input cap, startup rejection of
  invalid patterns, and a 400 for a non-matching key alias. This is a naming
  validation feature, not model routing; only its bounded-input and validation
  ergonomics are relevant analogies.

## Proposed Contract

1. Keep exact aliases first. If the inbound model exactly names an exact alias,
   that row wins even if a regex rule also matches. Do not fall through to a
   regex rule when the exact alias is found but its targets fail: retain the
   current exact alias 404/400 semantics instead of making routing depend on
   fallback order.
2. Evaluate enabled regex rules only after no exact alias matched. Sort by
   explicit `priority` descending, then stable creation order and ID. The
   first full-match rule wins; later overlapping rules are not merged or
   retried. Keep this dispatch priority separate from exact aliases'
   `sort_order`, which remains a listing-only field.
3. Treat a regex rule as a routing transformation from one inbound model ID to
   one concrete real model ID. Resolve the transformed ID through the existing
   real-model resolver exactly once; maximum regex-expansion depth is one.
   Do not resolve it as another exact alias or regex rule. This makes regex
   cycles impossible by construction and leaves existing exact aliases'
   nested failover semantics intact.
4. Use RE2-compatible syntax with implicit full-string matching and fixed
   case-sensitive semantics. Do not allow inline mode flags to change those
   semantics. Match the original UTF-8 model ID exactly: no normalization,
   trimming, case folding, or prefix removal. Model IDs are opaque upstream-
   owned strings; regex routing must not silently change them before matching.
5. Permit named captures (`(?P<name>...)`) and literal replacement templates
   with `${name}` placeholders only. Expand once, with no recursive
   substitution or replacement regex. Reject unknown placeholders on save;
   treat an unmatched optional capture as empty, then reject an empty or
   over-limit output ID. Escaping/quoting is unnecessary because captured text
   is copied literally, not parsed as a template a second time.
6. Reject duplicate pattern/priority rows as a likely accidental ambiguity.
   General overlap cannot be reliably ruled out for arbitrary user regexes;
   make first-match priority explicit in the UI and provide example-input
   previews instead of claiming all overlaps are statically detected.
7. Use a linear-time RE2 implementation, not unbounded backtracking
   `RegExp`, for production evaluation. Bound rule count, pattern bytes,
   input model-ID bytes, capture count, replacement bytes, and the engine's
   compile-memory budget. Candidate starting limits for review are 128 rules,
   255 UTF-8 bytes each for pattern/input/output, and 16 captures. These are
   proposals, not measured repository limits; confirm them against supported
   model IDs and deployment budgets before implementation.

## Errors, UI, And Compatibility

Invalid pattern syntax, an unsupported construct, an unknown template capture,
or a duplicate rule should be a control-plane 400 with a field-specific
message; do not persist an invalid rule. Validate through the same
engine used at runtime. If persisted rules cannot be compiled during startup,
fail closed and report the original compile error rather than silently
disabling routing.

When no regex rule matches, pass the original model ID to the existing real
resolver unchanged. When a rule matches but its target model is unavailable,
do not try a lower-priority rule: preserve the existing resolver's 404 for an
unknown model and 400 for a known model of the wrong kind. Internal engine
failures remain internal errors with their original error chain; never turn
them into a user-caused 404.

Keep regex rules out of `/v1/models`: their output space is not enumerable.
Present them separately from concrete aliases in the dashboard, with enabled
state, priority, pattern, target template, capture validation, overlap-order
explanation, and a test-input preview. Server-side validation is authoritative;
client-only JavaScript regex validation would disagree with RE2. Existing
`visible_in_models_list` continues to apply only to exact aliases.

## Decisions Required Before Production Routing

- Confirm that regex replacement outputs bind only real models rather than
  entering the existing exact-alias graph. This proposal recommends keeping
  regex expansion non-recursive while preserving exact-alias nesting.
- Give regex rules their own `enabled` field, following exact aliases' switch;
  do not overload `visible_in_models_list`, because it does not disable routing.
- Select and verify one maintained RE2-compatible implementation across Node,
  Cloudflare Workers, tests, and any import/export path. The repository has no
  RE2 dependency today; a Worker Wasm build is not yet proven.
- Approve priority direction/tie-break, limits, rule persistence/import format,
  and whether an exact alias whose target fails must always suppress regex
  fallback. This proposal recommends the deterministic behavior above.
