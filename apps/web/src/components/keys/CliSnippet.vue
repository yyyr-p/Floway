<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';

import {
  addCtxSuffix, CLAUDE_RE, CLAUDE_TIER_KEYS, CLAUDE_TIER_LABELS, type ClaudeTierKey, CODEX_RE,
  computeContextById, type GroupedIds, partition, sortByTierDistance, sortCodex,
} from './cli-snippet-helpers.ts';
import type { ControlPlaneModel } from '../../api/types.ts';
import { Code } from '@floway-dev/ui';

const props = defineProps<{
  apiKey: string;
  models: ControlPlaneModel[];
}>();

const baseUrl = computed(() => window.location.origin);

// Each `<select>` lists every chat model, sort-ordered so the family the
// target CLI natively expects (claude-* for Claude Code, gpt-5* for Codex)
// lands at the top and defaults each tier slot to the canonical Fable /
// Opus / Sonnet / Haiku pick. Non-matching ids stay selectable so operators
// can route through Floway's translation layer (e.g.
// `ANTHROPIC_DEFAULT_SONNET_MODEL=gpt-4.1` reaches the /v1/messages
// endpoint and gets translated onto the OpenAI-shaped upstream). Backend
// already collapses dated / variant suffixes; dedupe by id.
const chatModelIds = computed(() => [...new Set(props.models.filter(m => m.kind === 'chat').map(m => m.id))]);

const claudeModelsByTier = computed(() => Object.fromEntries(
  CLAUDE_TIER_KEYS.map(k => [k, [...chatModelIds.value].sort(sortByTierDistance(k))]),
) as Record<ClaudeTierKey, string[]>);
const codexModels = computed(() => [...chatModelIds.value].sort(sortCodex));

// `<optgroup>` split: matched ids appear under the family label, everything
// else under "Other". Even with the family-first sort putting matched ids at
// the top, a native visual separator matters when the pool grows past a
// dozen items — a plain unlabeled list makes it hard to tell where the
// operator's untranslated foreign models begin. Zero-length groups collapse
// via `v-if` so a single-family pool renders as one labeled group with no
// empty "Other" section beneath.
const claudeGroupsByTier = computed(() => Object.fromEntries(
  CLAUDE_TIER_KEYS.map(k => [k, partition(claudeModelsByTier.value[k], CLAUDE_RE)]),
) as Record<ClaudeTierKey, GroupedIds>);
const codexGroups = computed(() => partition(codexModels.value, CODEX_RE));

const claudeSelection = ref<Record<ClaudeTierKey, string>>({ fable: '', opus: '', sonnet: '', haiku: '' });
const codexModel = ref('');

// Keep the selection valid as the model lists rehydrate: if the current pick
// disappears (e.g. an upstream toggled off), fall back to the first entry.
watchEffect(() => {
  for (const k of CLAUDE_TIER_KEYS) {
    if (!claudeModelsByTier.value[k].includes(claudeSelection.value[k])) claudeSelection.value[k] = claudeModelsByTier.value[k][0] ?? '';
  }
  if (!codexModels.value.includes(codexModel.value)) codexModel.value = codexModels.value[0] ?? '';
});

const contextById = computed(() => computeContextById(props.models));
const addCtx = (id: string) => addCtxSuffix(id, contextById.value);

// JSON fragment for `settings.json`'s `env` block, not shell exports: Claude
// Code's background-agent supervisor doesn't reliably inherit shell env
// (dispatching into a different cwd drops it, and the SDK / -p paths don't
// see it either) — settings.json is the only channel that reaches every
// execution context. Emit only the `env` sub-object so the user pastes it
// into their existing settings without clobbering unrelated fields.
const claudeSnippet = computed(() => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: baseUrl.value,
    ANTHROPIC_AUTH_TOKEN: props.apiKey,
    ANTHROPIC_DEFAULT_FABLE_MODEL: addCtx(claudeSelection.value.fable),
    ANTHROPIC_DEFAULT_OPUS_MODEL: addCtx(claudeSelection.value.opus),
    ANTHROPIC_DEFAULT_SONNET_MODEL: addCtx(claudeSelection.value.sonnet),
    ANTHROPIC_DEFAULT_HAIKU_MODEL: claudeSelection.value.haiku,
  },
}, null, 2));

// Codex treats an actor-authorized custom provider as eligible for its
// client-owned search and image extensions. This non-secret marker selects
// those tools locally; Floway removes it before provider dispatch.
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/ext/web-search/src/extension.rs#L39-L49
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/core/src/tools/spec_plan.rs#L367-L394
const codexSnippet = computed(() => [
  `model = "${codexModel.value}"`,
  'model_provider = "floway"',
  '',
  '[model_providers.floway]',
  'name = "Floway"',
  `base_url = "${baseUrl.value}/azure-api.codex"`,
  // Command auth is provider-scoped and also opts the provider into online
  // model refresh; a static bearer or env key does not satisfy that gate.
  // https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
  'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] } # Linux & macOS',
  `# auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }; [IO.File]::ReadAllText((Join-Path $h 'floway-token'))"] } # Windows: uncomment and remove the line above`,
  'wire_api = "responses"',
  'supports_websockets = true',
  'http_headers = { "x-openai-actor-authorization" = "1" }',
  '',
  '[features]',
  'apps = false',
  'standalone_web_search = true',
].join('\n'));

const codexUnixCredentialCommand = computed(() => {
  const quotedApiKey = `'${props.apiKey.replaceAll("'", `'"'"'`)}'`;
  return [
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' ${quotedApiKey} > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join('\n');
});

const codexWindowsCredentialCommand = computed(() => {
  const quotedApiKey = `'${props.apiKey.replaceAll("'", "''")}'`;
  return [
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), ${quotedApiKey}, (New-Object Text.UTF8Encoding($false)))`,
  ].join('\n');
});

const selectClass = 'max-w-full text-xs font-mono bg-surface-800 text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none focus:border-accent-cyan/50 cursor-pointer';
</script>

<template>
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-5">
    <div>
      <div class="mb-3">
        <span class="text-sm font-semibold text-white">Claude Code</span>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-3">
        <div v-for="k in CLAUDE_TIER_KEYS" :key="k" class="flex min-w-0 items-center gap-2">
          <label class="text-xs text-gray-500">{{ CLAUDE_TIER_LABELS[k] }}:</label>
          <select v-model="claudeSelection[k]" :class="selectClass">
            <optgroup v-if="claudeGroupsByTier[k].matched.length" label="Claude">
              <option v-for="m in claudeGroupsByTier[k].matched" :key="m" :value="m">{{ m }}</option>
            </optgroup>
            <optgroup v-if="claudeGroupsByTier[k].other.length" label="Other">
              <option v-for="m in claudeGroupsByTier[k].other" :key="m" :value="m">{{ m }}</option>
            </optgroup>
          </select>
        </div>
      </div>

      <p class="text-[11px] text-gray-600 mb-2">Merge the <code class="text-gray-500">env</code> block into <code class="text-gray-500">~/.claude/settings.json</code> (user-scope) or <code class="text-gray-500">.claude/settings.json</code> (project-scope)</p>
      <Code :code="claudeSnippet" language="json" />
    </div>

    <div>
      <div class="mb-3">
        <span class="text-sm font-semibold text-white">Codex</span>
      </div>

      <div class="flex min-w-0 items-center gap-2 mb-3">
        <label class="text-xs text-gray-500">Model:</label>
        <select v-model="codexModel" :class="selectClass">
          <optgroup v-if="codexGroups.matched.length" label="Codex">
            <option v-for="m in codexGroups.matched" :key="m" :value="m">{{ m }}</option>
          </optgroup>
          <optgroup v-if="codexGroups.other.length" label="Other">
            <option v-for="m in codexGroups.other" :key="m" :value="m">{{ m }}</option>
          </optgroup>
        </select>
      </div>

      <p class="text-[11px] text-gray-600 mb-2">Merge into <code class="text-gray-500">~/.codex/config.toml</code></p>
      <Code :code="codexSnippet" language="toml" />

      <p class="text-[11px] text-gray-600 mt-4 mb-2">Linux &amp; macOS — stores only the Floway provider token under the active <code class="text-gray-500">CODEX_HOME</code></p>
      <Code :code="codexUnixCredentialCommand" language="bash" />

      <p class="text-[11px] text-gray-600 mt-4 mb-2">Windows PowerShell — stores the same provider token without changing the official account login</p>
      <Code :code="codexWindowsCredentialCommand" language="text" />
    </div>
  </div>
</template>
