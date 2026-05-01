/**
 * R2 sprint 1 — help text and unknown-flag tests.
 *
 * Covers F-AC1 (--help body), F-AC2 (-h byte-equiv), F-AC3 (unknown flag),
 * and the F4 user-facing-prose check (no `npm run …`, no `the npm package`,
 * no `the Node MCP server`, no bare `npm install` instructions).
 */
import { describe, expect, it } from 'vitest';
import { spawnInstaller } from './_spawn.js';

describe('install.sh --help / -h', () => {
  it('prints help on --help and exits 0', async () => {
    const result = await spawnInstaller({ args: ['--help'] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain('--uninstall');
    expect(result.stdout).toContain('--no-claude-code');
    expect(result.stdout).toContain('20.10');
    expect(result.stdout).toContain('Node');
    expect(result.stdout).toContain('git');
    expect(result.stdout).toContain('Claude Code');
    // Names the framework rather than "the Node MCP server" / "the npm package".
    const claimsFramework =
      result.stdout.includes('ClaudeAgents') || result.stdout.includes('the framework');
    expect(claimsFramework).toBe(true);
    // Mentions exit-code convention.
    expect(result.stdout.toLowerCase()).toContain('exit');
    // Pointer to README.
    expect(result.stdout).toMatch(/README/i);
  });

  it('-h emits byte-identical output to --help', async () => {
    const long = await spawnInstaller({ args: ['--help'] });
    const short = await spawnInstaller({ args: ['-h'] });
    expect(short.exitCode).toBe(0);
    expect(short.stdout).toBe(long.stdout);
  });

  it('rejects unknown flags with a non-zero exit and a pointer to --help on stderr', async () => {
    const result = await spawnInstaller({ args: ['--definitely-not-a-real-flag'] });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('--definitely-not-a-real-flag');
    expect(result.stderr.toLowerCase()).toContain('--help');
    // Unknown-flag path should not print the help body to stdout.
    expect(result.stdout).toBe('');
  });

  it('help text obeys the F4 user-facing prose discipline', async () => {
    const result = await spawnInstaller({ args: ['--help'] });
    expect(result.exitCode).toBe(0);
    const out = result.stdout;
    // Forbidden phrasings (F4):
    expect(out).not.toMatch(/npm run\b/);
    expect(out).not.toMatch(/the npm package/i);
    expect(out).not.toMatch(/the Node MCP server/i);
    // No bare `npm install <thing>` remediation in user-facing help text.
    expect(out).not.toMatch(/\bnpm install\b/);
  });
});
