/**
 * R3 sprint 1 — top-level + per-subcommand help, unknown-flag handling.
 *
 * Covers contract criteria F-AC7 (top-level help), F-AC8 (per-subcommand
 * help), and F-AC9 (unknown-flag → exit 64, unknown-subcommand → exit 64).
 */
import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';

describe('gan help surface', () => {
  it('F-AC7: --help prints top-level help to stdout, exits 0', async () => {
    const r = await runGan(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('gan');
    // Skill-vs-CLI line is part of the contract (R3 spec, help-text section).
    expect(r.stdout).toContain('Note: to run a sprint, use the /gan skill');
    // Subcommand list — every name from the surface table.
    for (const sub of ['version', 'validate', 'config', 'stacks', 'stack', 'modules', 'trust']) {
      expect(r.stdout).toContain(sub);
    }
    // Global flags + exit-code table.
    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--project-root');
    expect(r.stdout).toContain('Exit codes');
  });

  it('F-AC7: -h is byte-equivalent to --help', async () => {
    const long = await runGan(['--help']);
    const short = await runGan(['-h']);
    expect(short.exitCode).toBe(0);
    expect(short.stderr).toBe('');
    expect(short.stdout).toBe(long.stdout);
  });

  it('F-AC7: `gan help` is byte-equivalent to --help', async () => {
    const long = await runGan(['--help']);
    const helpSub = await runGan(['help']);
    expect(helpSub.exitCode).toBe(0);
    expect(helpSub.stderr).toBe('');
    expect(helpSub.stdout).toBe(long.stdout);
  });

  it('F-AC7: bare `gan` (no args) prints top-level help and exits 0', async () => {
    const long = await runGan(['--help']);
    const bare = await runGan([]);
    expect(bare.exitCode).toBe(0);
    expect(bare.stderr).toBe('');
    expect(bare.stdout).toBe(long.stdout);
  });

  it('F-AC8: `gan <subcommand> --help` prints subcommand help, exits 0', async () => {
    for (const sub of ['version', 'validate', 'config', 'stacks', 'stack', 'modules', 'trust']) {
      const r = await runGan([sub, '--help']);
      expect(r.exitCode, `subcommand ${sub} should exit 0`).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.stdout).toContain(`gan ${sub}`);
      expect(r.stdout.toLowerCase()).toContain('usage');
      expect(r.stdout).toMatch(/Examples:/);
      expect(r.stdout).toMatch(/Exit codes:/);
    }
  });

  it('F-AC8: `gan <subcommand> -h` is byte-equivalent to --help', async () => {
    const long = await runGan(['version', '--help']);
    const short = await runGan(['version', '-h']);
    expect(short.exitCode).toBe(0);
    expect(short.stdout).toBe(long.stdout);
  });

  it('F-AC8: `gan help <subcommand>` matches `gan <subcommand> --help`', async () => {
    const viaFlag = await runGan(['version', '--help']);
    const viaHelpSub = await runGan(['help', 'version']);
    expect(viaHelpSub.exitCode).toBe(0);
    expect(viaHelpSub.stdout).toBe(viaFlag.stdout);
  });

  it('F-AC9: unknown subcommand exits 64 with --help pointer', async () => {
    const r = await runGan(['definitely-not-a-real-subcommand']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('definitely-not-a-real-subcommand');
    expect(r.stderr).toContain('--help');
  });

  it('F-AC9: unknown flag exits 64 with --help pointer', async () => {
    const r = await runGan(['--definitely-not-a-real-flag']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--definitely-not-a-real-flag');
    expect(r.stderr).toContain('--help');
  });
});
