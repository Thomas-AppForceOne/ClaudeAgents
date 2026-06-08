/**
 * Migrate-command tests for `gan hooks migrate --delete | --replace |
 * --review`.
 *
 * The migrate surface ships three deterministic remediation actions for a
 * stale or misconfigured project-tier confinement hook:
 *
 * - `--delete`:  atomic backup-then-unlink. Backup sibling is written via
 *                temp+rename FIRST; only after the backup succeeds is the
 *                original unlinked. A fault-injection variant proves that
 *                a failed backup write leaves the original intact (the
 *                load-bearing atomicity property).
 * - `--replace`: atomic backup-then-overwrite with the framework's current
 *                rendered template (substituted banner). The absent-hook
 *                edge case creates the file without writing a backup.
 * - `--review`:  pure read; prints the unified diff between the project-tier
 *                hook and the current template, exits 0 without writing.
 *
 * Confirmation discipline: TTY confirmation prompt (bare-Enter defaults to
 * N) or `--yes` flag; non-TTY without `--yes` fails closed with
 * `subReason: 'confirmationRequired'`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { run as runMigrate } from '../../src/cli/commands/hooks/migrate.js';
import { canonicalizePath } from '../../src/config-server/determinism/index.js';
import { repoRootDir } from './helpers/spawn.js';
import { renderedTemplate } from './helpers/confineTemplate.js';

const cleanups: string[] = [];

// The global vitest setup at `tests/setup.ts` repoints
// GAN_PACKAGE_ROOT_OVERRIDE at an empty fake root so built-in stack
// fixtures don't leak into stack-resolution tests. The migrate command
// reads the framework's template from that root, so for THIS suite we
// repoint it back to the real repo root for the duration of the test
// file. Saved + restored in beforeAll/afterAll so the rest of the suite
// is unaffected.
const SAVED_PKG_OVERRIDE = process.env.GAN_PACKAGE_ROOT_OVERRIDE;

beforeAll(() => {
  process.env.GAN_PACKAGE_ROOT_OVERRIDE = repoRootDir();
});

afterAll(() => {
  if (SAVED_PKG_OVERRIDE !== undefined) {
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = SAVED_PKG_OVERRIDE;
  } else {
    delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  }
});

// resolveProjectRoot canonicalises with the framework's `canonicalizePath`
// helper, which expands `/var/folders/...` to `/private/var/folders/...`
// AND lower-cases on case-insensitive filesystems. Tests compute expected
// paths off the same helper so backup-sibling and message assertions
// match the canonical form the command emits.
function canonical(p: string): string {
  return canonicalizePath(p);
}

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

function seedHook(root: string, content: string, mode = 0o755): string {
  const dir = path.join(root, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gan-confine.sh');
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

// A deterministic fake clock for backup-sibling filename assertions.
// The timestamp the migrate command embeds preserves millisecond
// precision so two same-second invocations produce distinct filenames
// (the collision-safe property exercised by the
// `produces distinct backup paths` test below); the fixture mirrors that
// shape verbatim.
const FIXED_DATE = new Date('2026-06-08T19:42:11.000Z');
const FIXED_TIMESTAMP = '2026-06-08T19:42:11.000Z';

const STALE_HOOK = '#!/bin/bash\nexit 1\n';

// A stdin adapter that simulates non-TTY input (CI, scripted invocation).
const NON_TTY_STDIN = {
  isTTY: false,
  readLine: (): string | null => null,
};

// A stdin adapter that simulates a TTY answering `y` once.
function makeTtyYesStdin() {
  let consumed = false;
  return {
    isTTY: true,
    readLine: (): string | null => {
      if (consumed) return null;
      consumed = true;
      return 'y';
    },
  };
}

// Build a ParsedArgs-shaped object for the migrate command.
function makeArgs(opts: {
  action: 'delete' | 'replace' | 'review';
  yes?: boolean;
  projectRoot: string;
}) {
  const flags: Record<string, string | boolean> = {
    json: false,
    help: false,
    'project-root': opts.projectRoot,
  };
  if (opts.action === 'delete') flags['delete'] = true;
  if (opts.action === 'replace') flags['replace'] = true;
  if (opts.action === 'review') flags['review'] = true;
  if (opts.yes) flags['yes'] = true;
  return { _: [], flags, doubleDashSeen: false };
}

describe('gan hooks migrate --delete', () => {
  it('present hook: writes backup sibling, unlinks original, prints rollback hint', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const hookPath = seedHook(cwd, STALE_HOOK);
    const result = await runMigrate(
      makeArgs({ action: 'delete', yes: true, projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const expectedBackup = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${FIXED_TIMESTAMP}`,
    );
    expect(existsSync(hookPath)).toBe(false);
    expect(existsSync(expectedBackup)).toBe(true);
    expect(readFileSync(expectedBackup, 'utf8')).toBe(STALE_HOOK);
    expect(result.stdout).toContain(expectedBackup);
    expect(result.stdout).toContain('mv');
  });

  it('absent hook: no-op message, exit 0', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const result = await runMigrate(
      makeArgs({ action: 'delete', yes: true, projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no project-tier hook present at');
    expect(result.stdout).toContain('nothing to delete');
  });

  it('fault-injection: backup rename failure leaves original intact', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const hookPath = seedHook(cwd, STALE_HOOK);
    // Fault-injection: make the backup-sibling rename fail by planting a
    // sub-directory at the backup-target path. POSIX rename refuses to
    // overwrite a non-empty directory with a regular file, so the temp
    // file's rename onto the backup path throws — and the atomic
    // backup-then-unlink ordering guarantees the original hook stays in
    // place because the unlink only fires after the rename succeeds.
    const backupPath = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${FIXED_TIMESTAMP}`,
    );
    mkdirSync(backupPath);
    // Add a child file so the directory cannot be unlinked / clobbered.
    writeFileSync(path.join(backupPath, 'blocker'), 'blocker');
    const result = await runMigrate(
      makeArgs({ action: 'delete', yes: true, projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code).not.toBe(0);
    // Original hook is still there; no unlink ran.
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf8')).toBe(STALE_HOOK);
    // The synthetic blocker dir is still in place; no successful rename
    // ever clobbered it.
    expect(existsSync(path.join(backupPath, 'blocker'))).toBe(true);
  });
});

describe('gan hooks migrate --replace', () => {
  it('present hook: backup written, hook overwritten with current template carrying banner', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const hookPath = seedHook(cwd, STALE_HOOK);
    const result = await runMigrate(
      makeArgs({ action: 'replace', yes: true, projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code, `stderr: ${result.stderr}\nstdout: ${result.stdout}`).toBe(0);
    const expectedBackup = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${FIXED_TIMESTAMP}`,
    );
    expect(existsSync(expectedBackup)).toBe(true);
    expect(readFileSync(expectedBackup, 'utf8')).toBe(STALE_HOOK);
    // The replacement is byte-identical to the rendered template.
    const replacement = readFileSync(hookPath, 'utf8');
    expect(replacement).toBe(renderedTemplate());
    // The banner is substituted (not the literal placeholder).
    const pkg = JSON.parse(
      readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8'),
    ) as { version: string };
    expect(replacement).toContain(`version ${pkg.version}.`);
    expect(replacement).not.toContain('__GAN_FRAMEWORK_VERSION__');
    expect(result.stdout).toContain(expectedBackup);
  });

  it('absent hook: creates file from template, no backup line in message', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const result = await runMigrate(
      makeArgs({ action: 'replace', yes: true, projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const hookPath = path.join(canonical(cwd), '.claude', 'hooks', 'gan-confine.sh');
    expect(existsSync(hookPath)).toBe(true);
    expect(readFileSync(hookPath, 'utf8')).toBe(renderedTemplate());
    expect(result.stdout).toContain(`created ${hookPath}`);
    expect(result.stdout).not.toContain('backup at');
    // No backup sibling on the create path.
    const backupPath = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${FIXED_TIMESTAMP}`,
    );
    expect(existsSync(backupPath)).toBe(false);
  });
});

describe('gan hooks migrate --review', () => {
  it('present hook: prints diff, exit 0, original untouched, no backup', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const hookPath = seedHook(cwd, STALE_HOOK);
    const before = readdirSync(path.join(cwd, '.claude', 'hooks'));
    const result = await runMigrate(
      makeArgs({ action: 'review', projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('---');
    expect(result.stdout).toContain('+++');
    expect(readFileSync(hookPath, 'utf8')).toBe(STALE_HOOK);
    const after = readdirSync(path.join(cwd, '.claude', 'hooks'));
    // No new file landed.
    expect(after.sort()).toEqual(before.sort());
  });

  it('absent hook: no-op, exit 0, no backup', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const result = await runMigrate(
      makeArgs({ action: 'review', projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no project-tier hook present at');
    expect(result.stdout).toContain('nothing to diff');
  });

  it('--review is exempt from the confirmation prompt and from --yes', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    seedHook(cwd, STALE_HOOK);
    // Pass non-TTY stdin: --review must not consult it at all.
    const result = await runMigrate(
      makeArgs({ action: 'review', projectRoot: cwd }),
      { stdin: NON_TTY_STDIN, now: () => FIXED_DATE },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('---');
  });
});

describe('gan hooks migrate confirmation discipline', () => {
  it('non-TTY stdin without --yes on --delete: exit 2 with confirmationRequired', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    seedHook(cwd, STALE_HOOK);
    const result = await runMigrate(
      makeArgs({ action: 'delete', projectRoot: cwd }),
      { stdin: NON_TTY_STDIN, now: () => FIXED_DATE },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('confirmationRequired');
    expect(result.stderr).toContain('--yes');
  });

  it('non-TTY stdin without --yes on --replace: exit 2 with confirmationRequired', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    seedHook(cwd, STALE_HOOK);
    const result = await runMigrate(
      makeArgs({ action: 'replace', projectRoot: cwd }),
      { stdin: NON_TTY_STDIN, now: () => FIXED_DATE },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('confirmationRequired');
    expect(result.stderr).toContain('--yes');
  });

  it('--yes skips the prompt on --delete', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const hookPath = seedHook(cwd, STALE_HOOK);
    const result = await runMigrate(
      makeArgs({ action: 'delete', yes: true, projectRoot: cwd }),
      { stdin: NON_TTY_STDIN, now: () => FIXED_DATE },
    );
    expect(result.code).toBe(0);
    expect(existsSync(hookPath)).toBe(false);
  });

  it('TTY stdin answering `y` proceeds with --delete', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const hookPath = seedHook(cwd, STALE_HOOK);
    const result = await runMigrate(
      makeArgs({ action: 'delete', projectRoot: cwd }),
      { stdin: makeTtyYesStdin(), now: () => FIXED_DATE },
    );
    expect(result.code).toBe(0);
    expect(existsSync(hookPath)).toBe(false);
  });
});

describe('gan hooks migrate action selection', () => {
  it('no action selected: exit 2 with usage message', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const flags: Record<string, string | boolean> = {
      json: false,
      help: false,
      'project-root': cwd,
    };
    const result = await runMigrate(
      { _: [], flags, doubleDashSeen: false },
      { stdin: NON_TTY_STDIN, now: () => FIXED_DATE },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('exactly one of --delete / --replace / --review');
  });

  it('multiple actions selected: exit 2 with usage message', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    const flags: Record<string, string | boolean> = {
      json: false,
      help: false,
      'project-root': cwd,
      delete: true,
      replace: true,
    };
    const result = await runMigrate(
      { _: [], flags, doubleDashSeen: false },
      { stdin: NON_TTY_STDIN, now: () => FIXED_DATE },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('got more than one');
  });
});

describe('gan hooks migrate backup-sibling preserves source mode', () => {
  // The documented rollback is `mv <backup> <hook>`, which preserves the
  // BACKUP's mode bits on the restored file. If the backup were written
  // at 0o644 (Node's `writeFileSync` default under a standard 0o022
  // umask), the restored hook would lose its executable bit and Claude
  // Code would either skip it silently or refuse to spawn it with
  // EACCES. The atomicWriteBuffer helper therefore propagates the source
  // hook's `mode & 0o7777` to the backup file.
  it('--delete: 0o755 source → backup with executable bit set', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    seedHook(cwd, STALE_HOOK, 0o755);
    const result = await runMigrate(
      makeArgs({ action: 'delete', yes: true, projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const backupPath = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${FIXED_TIMESTAMP}`,
    );
    expect(existsSync(backupPath)).toBe(true);
    // The 0o111 mask isolates the user/group/other execute bits; any
    // one of them being set means `mv backup hook` restores a runnable
    // file.
    expect(statSync(backupPath).mode & 0o111).not.toBe(0);
  });

  it('--replace: 0o755 source → backup with executable bit set', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    seedHook(cwd, STALE_HOOK, 0o755);
    const result = await runMigrate(
      makeArgs({ action: 'replace', yes: true, projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    const backupPath = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${FIXED_TIMESTAMP}`,
    );
    expect(existsSync(backupPath)).toBe(true);
    expect(statSync(backupPath).mode & 0o111).not.toBe(0);
  });
});

describe('gan hooks migrate backup-sibling timestamp is collision-safe', () => {
  // Two invocations within the same UTC second MUST NOT silently
  // overwrite the prior backup. The millisecond-precision timestamp
  // (the toISOString shape `YYYY-MM-DDTHH:MM:SS.sssZ`) ensures distinct
  // filenames when the two calls land at different sub-second instants.
  it('--delete: two invocations at distinct milliseconds produce distinct backup paths', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    seedHook(cwd, STALE_HOOK, 0o755);
    const firstDate = new Date('2026-06-08T19:42:11.100Z');
    const firstResult = await runMigrate(
      makeArgs({ action: 'delete', yes: true, projectRoot: cwd }),
      { now: () => firstDate },
    );
    expect(firstResult.code, `stderr: ${firstResult.stderr}`).toBe(0);
    // Re-seed the hook so a second --delete has something to back up
    // and the same UTC second is exercised on a fresh file.
    seedHook(cwd, '#!/bin/bash\nexit 7\n', 0o755);
    const secondDate = new Date('2026-06-08T19:42:11.250Z');
    const secondResult = await runMigrate(
      makeArgs({ action: 'delete', yes: true, projectRoot: cwd }),
      { now: () => secondDate },
    );
    expect(secondResult.code, `stderr: ${secondResult.stderr}`).toBe(0);
    const firstBackup = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${firstDate.toISOString()}`,
    );
    const secondBackup = path.join(
      canonical(cwd),
      '.claude',
      'hooks',
      `gan-confine.sh.gan-bak.${secondDate.toISOString()}`,
    );
    expect(firstBackup).not.toBe(secondBackup);
    expect(existsSync(firstBackup)).toBe(true);
    expect(existsSync(secondBackup)).toBe(true);
    // Each backup carries the bytes it captured, not the other's.
    expect(readFileSync(firstBackup, 'utf8')).toBe(STALE_HOOK);
    expect(readFileSync(secondBackup, 'utf8')).toBe('#!/bin/bash\nexit 7\n');
  });
});

describe('gan hooks migrate --review produces a real unified diff', () => {
  // The criterion: a single-line drift (one inserted line near the top
  // of the project hook) produces a small localised hunk, not a
  // full-file -/+ projection from the drift point onward. The LCS-based
  // diff finds the alignment so all unchanged lines below the
  // insertion are emitted as context lines.
  it('--review: one inserted line near the top → small hunk with one +/- pair', async () => {
    const cwd = makeTmpDir('gan-migrate-');
    // Stage a project hook that is byte-identical to the framework
    // template EXCEPT for one inserted line near the top.
    const template = renderedTemplate();
    const lines = template.split('\n');
    // Insert a comment line at index 2 (after the shebang and the
    // first comment) so the drift is early in the file and the naive
    // projection would print every subsequent line as a mismatch.
    const drifted = [
      lines[0],
      lines[1],
      '# Operator-added comment line',
      ...lines.slice(2),
    ].join('\n');
    seedHook(cwd, drifted, 0o755);
    const result = await runMigrate(
      makeArgs({ action: 'review', projectRoot: cwd }),
      { now: () => FIXED_DATE },
    );
    expect(result.code, `stderr: ${result.stderr}`).toBe(0);
    // Count the +/- body lines (the first two lines starting with `---`
    // and `+++` are the file headers, not body lines).
    const bodyLines = result.stdout.split('\n');
    const minus = bodyLines.filter(
      (l) => l.startsWith('-') && !l.startsWith('---'),
    );
    const plus = bodyLines.filter(
      (l) => l.startsWith('+') && !l.startsWith('+++'),
    );
    // A real LCS produces exactly one `-` (the inserted line, which is
    // present in the project hook on the LEFT but absent from the
    // framework template on the RIGHT) and zero `+` lines for this
    // case; a naive line-index projection produces dozens of
    // mismatched pairs.
    expect(minus.length).toBe(1);
    expect(plus.length).toBe(0);
    expect(minus[0]).toBe('-# Operator-added comment line');
    // Context lines (lines starting with a space) MUST exist after the
    // drift — proof the alignment recovered and the rest of the file
    // is reported as unchanged.
    const context = bodyLines.filter((l) => l.startsWith(' '));
    expect(context.length).toBeGreaterThan(5);
  });
});

// Used internally by `beforeEach` registration patterns; named to keep
// the linter quiet about the vitest import surface.
beforeEach(() => {
  /* per-test setup hook reserved for future use */
});
