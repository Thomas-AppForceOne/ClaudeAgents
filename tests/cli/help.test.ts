/**
 * End-to-end tests for the `gan` help surface (acceptance criteria F-AC7/8/9).
 *
 * The contract under test is that help is reachable through every idiomatic
 * spelling and that the spellings are byte-equivalent:
 * - top-level help via `--help`, `-h`, `gan help`, and bare `gan` (no args) all
 *   print the same text to stdout and exit 0;
 * - subcommand help via `gan <sub> --help`, `-h`, and `gan help <sub>` likewise
 *   agree and each carry Usage / Examples / Exit codes sections;
 * - unknown subcommands and unknown flags exit 64 (usage error) on stderr with
 *   a pointer back to `--help`, never a stack trace.
 * Byte-equality is asserted (not just "contains") so the aliases cannot drift.
 */

import { describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';

describe('gan help surface', () => {
  it('F-AC7: --help prints top-level help to stdout, exits 0', async () => {
    const r = await runGan(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('gan');

    // The CLI deliberately does not run sprints; this line steers users to the
    // /gan skill instead, so its presence is part of the help contract.
    expect(r.stdout).toContain('Note: to run a sprint, use the /gan skill');

    // Every shipped subcommand must be discoverable from the top-level help.
    for (const sub of ['version', 'validate', 'config', 'stacks', 'stack', 'modules', 'trust']) {
      expect(r.stdout).toContain(sub);
    }

    expect(r.stdout).toContain('--json');
    expect(r.stdout).toContain('--project-root');
    expect(r.stdout).toContain('Exit codes');
  });

  // The three alternate spellings of top-level help below each assert
  // byte-identical stdout against `--help` — the alias guarantee, not just that
  // help text appears.
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
    // Drives every subcommand's help in one loop; the per-iteration message on
    // the exit-code assertion names which subcommand failed if the loop trips.
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

  // Error paths: 64 is the conventional usage-error exit code; the offending
  // token is echoed back and a `--help` pointer is offered, with stdout empty
  // (errors belong on stderr).
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

  // The action flags `--delete`, `--replace`, and `--review` are
  // declared at the top-level parser (the parser is single-pass with
  // `allowUnknownFlags: false`, so every flag any subcommand accepts
  // must appear on the top-level spec). The dispatcher rejects them
  // when supplied to any subcommand other than `gan hooks migrate`,
  // because they would otherwise parse to a success exit with the
  // flag silently ignored — a surface that advertises capabilities
  // a command does not honour.
  it('F-AC9: --delete on a non-migrate subcommand exits 64 with guidance', async () => {
    const r = await runGan(['stacks', 'list', '--delete']);
    expect(r.exitCode).toBe(64);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--delete');
    expect(r.stderr).toContain('hooks migrate');
  });

  it('F-AC9: --replace on a non-migrate subcommand exits 64 with guidance', async () => {
    const r = await runGan(['validate', '--replace']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('--replace');
    expect(r.stderr).toContain('hooks migrate');
  });

  it('F-AC9: --review on a non-migrate subcommand exits 64 with guidance', async () => {
    const r = await runGan(['config', 'print', '--review']);
    expect(r.exitCode).toBe(64);
    expect(r.stderr).toContain('--review');
    expect(r.stderr).toContain('hooks migrate');
  });
});
