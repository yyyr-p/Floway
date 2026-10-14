import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAgentCodexSnippet, codexSpoofCredentialSnippet } from '../../../src/components/api-keys/agent-setup';

const hasPwsh = spawnSync('pwsh', ['--version']).status === 0;

describe('Codex spoof credential commands', () => {
  for (const platform of ['unix', 'windows'] as const) {
    it.skipIf(platform === 'windows' && !hasPwsh)(`${platform} backs up the login and writes the API key without shell interpolation`, () => {
      const home = mkdtempSync(join(tmpdir(), 'floway-manual-login-'));
      try {
        const original = '{"tokens":{"access_token":"original-login"}}';
        writeFileSync(join(home, 'auth.json'), original);
        const apiKey = 'key\'"\n$(exit 42); `exit 43`';
        const command = codexSpoofCredentialSnippet(apiKey, platform);
        const script = join(home, 'credential.ps1');
        writeFileSync(script, command);
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = spawnSync(platform === 'unix' ? 'bash' : 'pwsh', platform === 'unix' ? [] : ['-NoProfile', '-NonInteractive', '-File', script], {
            input: command,
            env: { ...process.env, CODEX_HOME: home },
            encoding: 'utf8',
            timeout: 10_000,
          });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
          expect(result.stdout).toContain('Original Codex login backed up at');
          expect(result.stdout).not.toContain(apiKey);
          const auth = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'));
          expect(auth.auth_mode).toBe('chatgpt');
          expect(auth.tokens.access_token).toBe(apiKey);
          expect(Date.now() - Date.parse(auth.last_refresh)).toBeLessThan(60_000);
          if (process.platform !== 'win32') expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
        }
        const backups = readdirSync(home).filter(name => name.startsWith('auth.json.floway-backup.'));
        expect(backups).toHaveLength(2);
        expect(backups.some(name => readFileSync(join(home, name), 'utf8') === original)).toBe(true);
        expect(readdirSync(home).some(name => name.includes('floway-stage'))).toBe(false);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }

  it('pairs account credentials with explicit ChatGPT auth and the Floway endpoints', () => {
    for (const platform of ['unix', 'windows'] as const) {
      const config = buildAgentCodexSnippet('https://floway.example', { authMode: 'chatgpt-spoof', model: null, reasoningEffort: null }, platform);
      expect(config).toContain('requires_openai_auth = true');
      expect(config).toContain('chatgpt_base_url = "https://floway.example/azure-api.codex"');
      expect(config).toContain('cli_auth_credentials_store = "file"');
      expect(config).not.toMatch(/^auth =/m);
      expect(config).not.toContain('floway-token');
    }
  });
});
