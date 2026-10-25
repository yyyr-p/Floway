import {
  SETUP_BASH_CLAUDE,
  SETUP_BASH_CODEX,
  SETUP_BASH_COMMON,
  SETUP_BASH_OMP,
  SETUP_BASH_OPENCODE,
  SETUP_BASH_PI,
  SETUP_BASH_VSCODE,
  SETUP_BASH_ZED,
  SETUP_NODE_JSONC_EDIT,
  SETUP_NODE_PI_INSTALLATION,
  SETUP_POWERSHELL_CLAUDE,
  SETUP_POWERSHELL_CODEX,
  SETUP_POWERSHELL_COMMON,
  SETUP_POWERSHELL_OMP,
  SETUP_POWERSHELL_OPENCODE,
  SETUP_POWERSHELL_PI,
  SETUP_POWERSHELL_VSCODE,
  SETUP_POWERSHELL_ZED,
  SETUP_PYTHON_CONVERTERS,
} from './script-assets.generated.ts';

export type ScriptAgent = 'claude' | 'codex' | 'pi' | 'omp' | 'vscode' | 'zed' | 'opencode';
export type ScriptLanguage = 'sh' | 'ps1';

export { SETUP_PYTHON_CONVERTERS };

const bashNodeHelper = (name: string, file: string, source: string): string => `
${name}() {
  cat <<'EOF' > "$SETUP_TMPDIR/${file}"
${source}
EOF
}
`;

const powerShellNodeHelper = (name: string, file: string, source: string): string => `
function ${name} {
  $target = Join-Path $script:PiTmpDir '${file}'
  $content = @'
${source}
'@
  [System.IO.File]::WriteAllText($target, $content, (New-Object Text.UTF8Encoding($false)))
}
`;

const BASH_PI_PRELUDE = bashNodeHelper('_write_jsonc_editor', 'jsonc-edit.mjs', SETUP_NODE_JSONC_EDIT)
  + bashNodeHelper('_write_pi_installation_checker', 'pi-installation.mjs', SETUP_NODE_PI_INSTALLATION);
const POWERSHELL_PI_PRELUDE = powerShellNodeHelper('Write-SetupJsoncEditor', 'jsonc-edit.mjs', SETUP_NODE_JSONC_EDIT)
  + powerShellNodeHelper('Write-SetupPiInstallationChecker', 'pi-installation.mjs', SETUP_NODE_PI_INSTALLATION);

export const SETUP_SCRIPT_BODIES = {
  claude: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_CLAUDE,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CLAUDE,
  },
  codex: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_CODEX,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_CODEX,
  },
  omp: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_OMP,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_OMP,
  },
  pi: {
    sh: SETUP_BASH_COMMON + BASH_PI_PRELUDE + SETUP_BASH_PI,
    ps1: SETUP_POWERSHELL_COMMON + POWERSHELL_PI_PRELUDE + SETUP_POWERSHELL_PI,
  },
  vscode: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_VSCODE,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_VSCODE,
  },
  zed: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_ZED,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_ZED,
  },
  opencode: {
    sh: SETUP_BASH_COMMON + SETUP_BASH_OPENCODE,
    ps1: SETUP_POWERSHELL_COMMON + SETUP_POWERSHELL_OPENCODE,
  },
} as const satisfies Record<ScriptAgent, Record<ScriptLanguage, string>>;
