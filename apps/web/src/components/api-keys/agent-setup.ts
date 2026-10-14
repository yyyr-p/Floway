import type { InferResponseType } from 'hono/client';

import type { api } from '../../api/client';
import { buildCodexSpoofAuth } from '@floway-dev/agent-setup/codex-auth';

export type AgentSetupLease = Extract<InferResponseType<typeof api.api.setup.$put>, { status: 'ok' }>;
export type AgentSetupConfiguration = AgentSetupLease['configuration'];

// What the form is edited into before a lease answers. The gateway authors the
// real first-use configuration and the dashboard never sees that code — types
// cross this boundary, values do not — so the field set here is held to the
// contract by the annotation: a field added or dropped server-side fails this
// literal to compile. The values only decide what the fields render in the
// seconds before a lease arrives, and they cannot reach a saved configuration,
// because applyLocalAgentSetupChanges measures the draft against this same
// object and copies nothing that was left alone.
export const blankAgentSetupDraft = (): AgentSetupConfiguration => ({
  apiKeyId: '',
  claudeCode: {
    model: null,
    defaultFableModel: null,
    defaultOpusModel: null,
    defaultSonnetModel: null,
    defaultHaikuModel: null,
    effortLevel: null,
    cleanupPeriodDays: null,
    optOutAiAttribution: false,
    disableAutoMemory: false,
    disableAgentView: false,
    modelDiscovery: true,
  },
  codex: { authMode: 'provider', model: null, reasoningEffort: null },
});

export const cloneAgentSetupConfiguration = (
  configuration: AgentSetupConfiguration,
): AgentSetupConfiguration => structuredClone(configuration);

export type AgentSetupPlatform = 'unix' | 'windows';

export const detectAgentSetupPlatform = (
  platform: string,
  userAgent: string,
): AgentSetupPlatform => /windows|win32|win64|wince/i.test(`${platform} ${userAgent}`)
  ? 'windows'
  : 'unix';

const copyChangedFields = <T extends object>(target: T, current: T, baseline: T) => {
  for (const key of Object.keys(current) as (keyof T)[]) {
    if (!Object.is(current[key], baseline[key])) target[key] = current[key];
  }
};

export const applyLocalAgentSetupChanges = (
  server: AgentSetupConfiguration,
  local: AgentSetupConfiguration,
  baseline: AgentSetupConfiguration,
): AgentSetupConfiguration => {
  const merged = cloneAgentSetupConfiguration(server);
  copyChangedFields(merged.claudeCode, local.claudeCode, baseline.claudeCode);
  copyChangedFields(merged.codex, local.codex, baseline.codex);
  return merged;
};

export const codexUnixCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", `'"'"'`)}'`;
  return [
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home" && \\',
    `  printf '%s' ${quoted} > "$codex_home/floway-token" && \\`,
    '  chmod 600 "$codex_home/floway-token"',
  ].join('\n');
};

export const codexWindowsCredentialSnippet = (apiKey: string) => {
  const quoted = `'${apiKey.replaceAll("'", "''")}'`;
  return [
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    `[IO.File]::WriteAllText((Join-Path $codexHome "floway-token"), ${quoted}, (New-Object Text.UTF8Encoding($false)))`,
  ].join('\n');
};

// The credential command stamps freshness when run, rather than when copied.
export const codexSpoofCredentialSnippet = (apiKey: string, platform: AgentSetupPlatform): string => {
  const auth = JSON.stringify(buildCodexSpoofAuth(apiKey, null));
  if (platform === 'windows') return [
    '$ErrorActionPreference = "Stop"',
    '$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }',
    'New-Item -ItemType Directory -Force -Path $codexHome | Out-Null',
    '$path = Join-Path $codexHome "auth.json"',
    'function Protect-FlowayLogin([string]$file) {',
    '  if ($env:OS -ne "Windows_NT") {',
    '    & chmod 600 $file',
    '    if ($LASTEXITCODE -ne 0) { throw "Could not protect $file" }',
    '    return',
    '  }',
    '  $acl = New-Object Security.AccessControl.FileSecurity',
    '  $user = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '  $acl.SetAccessRuleProtection($true, $false)',
    '  $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($user, "FullControl", "Allow")))',
    '  if ($PSVersionTable.PSVersion.Major -lt 6) { [IO.File]::SetAccessControl($file, $acl) }',
    '  else { [IO.FileSystemAclExtensions]::SetAccessControl([IO.FileInfo]::new($file), $acl) }',
    '}',
    'if (Test-Path -LiteralPath $path) {',
    '  $backup = "$path.floway-backup.$([DateTime]::UtcNow.Ticks).$PID"',
    '  [IO.File]::Create($backup).Dispose()',
    '  Protect-FlowayLogin $backup',
    '  [IO.File]::WriteAllBytes($backup, [IO.File]::ReadAllBytes($path))',
    '  Write-Host "Original Codex login backed up at $backup"',
    '}',
    `$auth = '${auth.replaceAll("'", "''")}' | ConvertFrom-Json`,
    '$auth.last_refresh = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")',
    '$stage = "$path.floway-stage.$PID"',
    'try {',
    '  [IO.File]::Create($stage).Dispose()',
    '  Protect-FlowayLogin $stage',
    '  [IO.File]::WriteAllText($stage, ($auth | ConvertTo-Json -Depth 10 -Compress), (New-Object Text.UTF8Encoding($false)))',
    '  Move-Item -LiteralPath $stage -Destination $path -Force',
    '} finally { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force } }',
  ].join('\n');
  return [
    '(',
    'set -eu',
    'umask 077',
    'codex_home="${CODEX_HOME:-$HOME/.codex}"',
    'mkdir -p "$codex_home"',
    'path="$codex_home/auth.json"',
    'if [ -e "$path" ]; then',
    '  backup=$(mktemp "$path.floway-backup.XXXXXX")',
    '  chmod 600 "$backup"',
    '  cat "$path" > "$backup"',
    '  printf "Original Codex login backed up at %s\\n" "$backup"',
    'fi',
    'stage="$path.floway-stage.$$"',
    `trap 'rm -f "$stage"' EXIT`,
    `printf '%s' '${auth.replaceAll("'", `'"'"'`)}' | sed 's/"last_refresh":null/"last_refresh":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"/' > "$stage"`,
    'chmod 600 "$stage"',
    'mv "$stage" "$path"',
    ')',
  ].join('\n');
};

// Empty strings suppress commit/PR attribution; false suppresses session links.
// https://code.claude.com/docs/en/settings#attribution-settings
const claudeAttributionOptOut = { commit: '', pr: '', sessionUrl: false } as const;

export const buildAgentClaudeSnippet = (
  origin: string,
  apiKey: string,
  settings: AgentSetupConfiguration['claudeCode'],
) => JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ...(settings.model ? { ANTHROPIC_MODEL: settings.model } : {}),
    ...(settings.defaultFableModel ? { ANTHROPIC_DEFAULT_FABLE_MODEL: settings.defaultFableModel } : {}),
    ...(settings.defaultOpusModel ? { ANTHROPIC_DEFAULT_OPUS_MODEL: settings.defaultOpusModel } : {}),
    ...(settings.defaultSonnetModel ? { ANTHROPIC_DEFAULT_SONNET_MODEL: settings.defaultSonnetModel } : {}),
    ...(settings.defaultHaikuModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: settings.defaultHaikuModel } : {}),
    ...(settings.modelDiscovery ? { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } : {}),
  },
  ...(settings.effortLevel ? { effortLevel: settings.effortLevel } : {}),
  ...(settings.cleanupPeriodDays === null ? {} : { cleanupPeriodDays: settings.cleanupPeriodDays }),
  ...(settings.optOutAiAttribution ? { attribution: claudeAttributionOptOut } : {}),
  ...(settings.disableAutoMemory ? { autoMemoryEnabled: false } : {}),
  ...(settings.disableAgentView ? { disableAgentView: true } : {}),
}, null, 2);

// JSON string literals are valid TOML basic strings, so JSON.stringify keeps
// opaque model values lossless. https://toml.io/en/v1.0.0#string
// x-openai-actor-authorization enables Codex-owned web search and image generation;
// command auth also enables live model refresh:
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/model-provider-info/src/lib.rs#L396-L408
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/ext/web-search/src/extension.rs#L41-L46
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/ext/image-generation/src/extension.rs#L38-L45
// https://github.com/openai/codex/blob/1bbdb32789e1f79932df44941236ea3658f6e965/codex-rs/models-manager/src/manager.rs#L413-L415
// Apps is ChatGPT-only; standalone web search requires explicit warning suppression:
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L382-L384
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L901-L905
// https://github.com/openai/codex/blob/24e9b849fad8f506971dfa0313dbdea8abd90112/codex-rs/features/src/lib.rs#L1393-L1439
// The auth command reads the token file the credential snippet writes, so the
// two halves of the Codex setup are one platform's pair: a shell that can read
// it, and a shell that wrote it.
export const buildAgentCodexSnippet = (origin: string, config: AgentSetupConfiguration['codex'], platform: 'unix' | 'windows') => [
  ...(config.model ? [`model = ${JSON.stringify(config.model)}`] : []),
  ...(config.reasoningEffort ? [`model_reasoning_effort = ${JSON.stringify(config.reasoningEffort)}`] : []),
  'model_provider = "floway"',
  ...(config.authMode === 'chatgpt-spoof' ? [
    `chatgpt_base_url = ${JSON.stringify(`${origin}/azure-api.codex`)}`,
    'cli_auth_credentials_store = "file"',
  ] : []),
  'suppress_unstable_features_warning = true',
  '',
  '[model_providers.floway]',
  'name = "Floway"',
  `base_url = ${JSON.stringify(`${origin}/azure-api.codex`)}`,
  ...(config.authMode === 'chatgpt-spoof' ? ['requires_openai_auth = true'] : [platform === 'windows'
    ? 'auth = { command = "powershell", args = ["-NoProfile", "-Command", "$h = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME \'.codex\' }; [IO.File]::ReadAllText((Join-Path $h \'floway-token\'))"] }'
    : 'auth = { command = "sh", args = ["-c", "cat \\"${CODEX_HOME:-$HOME/.codex}/floway-token\\""] }',
  'requires_openai_auth = false']),
  'wire_api = "responses"',
  'supports_websockets = true',
  'http_headers = { "x-openai-actor-authorization" = "1" }',
  '',
  '[features]',
  'apps = false',
  'standalone_web_search = true',
].join('\n');
