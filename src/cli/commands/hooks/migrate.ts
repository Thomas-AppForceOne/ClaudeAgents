/**
 * `gan hooks migrate` — three deterministic remediation actions for a
 * project-tier confinement hook the framework's contract has outgrown.
 *
 * Actions:
 * - `--delete`  removes `<project>/.claude/hooks/gan-confine.sh` after
 *               atomically backing up its prior contents to a timestamped
 *               `gan-confine.sh.gan-bak.<utc-iso>` sibling. The framework's
 *               user-tier hook then applies.
 * - `--replace` overwrites the project-tier hook with the framework's
 *               current rendered template, after the same atomic
 *               backup-then-rename dance. The replacement carries the
 *               framework version banner.
 * - `--review`  prints the unified diff between the current project-tier
 *               hook and the framework's current rendered template, then
 *               exits 0 without writing anything. Pure read.
 *
 * Confirmation discipline: `--delete` and `--replace` require an explicit
 * `y` on TTY stdin (bare-Enter defaults to `N`) or the `--yes` flag.
 * Non-TTY stdin without `--yes` fails closed with
 * `subReason: 'confirmationRequired'` and exit code `2`. `--review` is
 * pure read and exempt from both the prompt and `--yes`.
 *
 * Absent-project-tier-hook edge cases are deterministic too:
 * - `--delete`  → no-op message, exit 0.
 * - `--review`  → no-op message, exit 0.
 * - `--replace` → create the file from the framework's current template
 *                (no backup line in the message; the directory is created
 *                on demand).
 */

import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveProjectRoot } from '../../lib/project-root.js';
import {
  EXIT_BAD_ARGS,
  EXIT_GENERIC,
  EXIT_OK,
  EXIT_VALIDATION,
} from '../../lib/exit-codes.js';
import type { ParsedArgs } from '../../lib/args.js';

/**
 * Result contract shared by every CLI command handler.
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * One-shot stdin source. The migrate command reads at most a single line
 * from stdin (the confirmation answer); the helper is parameterised so
 * tests can substitute a non-TTY fixture without spawning a subprocess.
 *
 * @property isTTY whether the source is interactive; false for piped /
 *   redirected stdin.
 * @property readLine read one UTF-8 line synchronously; returns `null` on
 *   EOF. Implementations are free to throw on read errors — the caller
 *   treats any failure as `null`.
 */
export interface StdinAdapter {
  isTTY: boolean;
  readLine(): string | null;
}

/**
 * Options threaded into {@link run} for test isolation.
 *
 * @property stdin a {@link StdinAdapter} override; the default reads from
 *   `process.stdin` (interactive) or treats it as non-TTY otherwise.
 * @property now produces the UTC ISO timestamp embedded in the backup
 *   sibling filename. Override for deterministic test outputs; defaults to
 *   `new Date()`.
 */
export interface MigrateOptions {
  stdin?: StdinAdapter;
  now?: () => Date;
}

// File name prefix the backup siblings carry. Kept module-private — the
// matching scan in `status.ts` pins its own copy of the prefix with the
// same comment to avoid a circular import between the two CLI modules.
const BACKUP_SIBLING_PREFIX = 'gan-confine.sh.gan-bak.';

/**
 * Resolve the package root for the installed framework. Mirrors the
 * resolver in `commands/hooks/status.ts`; both honour
 * `GAN_PACKAGE_ROOT_OVERRIDE` as a test seam.
 */
function packageRoot(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  if (override !== undefined && override.length > 0) return override;
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..', '..', '..');
}

// Read the installed framework version from the package's `package.json`.
// Throws when the file is missing or malformed because `--replace`
// requires a substituted banner; a hook without a parseable banner is
// exactly the kind of file that breaks future `gan hooks status` reads,
// so a missing version is a defect not a warning.
function readInstalledFrameworkVersion(): string {
  const root = packageRoot();
  const raw = readFileSync(path.join(root, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(
      `gan hooks migrate: framework's package.json has no string 'version' field`,
    );
  }
  return parsed.version;
}

// Read the framework's current rendered confinement-hook template. The
// template lives at `<packageRoot>/scripts/hooks/gan-confine.sh.template`;
// every occurrence of `__GAN_FRAMEWORK_VERSION__` is substituted with the
// installed version (split/join so a multi-placeholder template renders
// correctly). The return value is byte-identical to what `install.sh`
// writes to the user-tier hook path.
function renderCurrentTemplate(): string {
  const root = packageRoot();
  const templatePath = path.join(root, 'scripts', 'hooks', 'gan-confine.sh.template');
  const tpl = readFileSync(templatePath, 'utf8');
  const version = readInstalledFrameworkVersion();
  return tpl.split('__GAN_FRAMEWORK_VERSION__').join(version);
}

// Default stdin adapter: reads up to one line via a synchronous `read` on
// fd 0. Returns null on EOF. The synchronous read keeps the call sequence
// simple — the user types one answer, hit Enter, the command continues —
// without spinning up an async readline interface.
function defaultStdinAdapter(): StdinAdapter {
  const isTTY = Boolean(process.stdin.isTTY);
  return {
    isTTY,
    readLine(): string | null {
      const buf = Buffer.alloc(64);
      const chars: number[] = [];
      try {
        while (true) {
          const bytes = readSync(0, buf, 0, buf.length, null);
          if (bytes === 0) {
            return chars.length === 0 ? null : Buffer.from(chars).toString('utf8');
          }
          for (let i = 0; i < bytes; i += 1) {
            const ch = buf[i]!;
            if (ch === 0x0a) {
              return Buffer.from(chars).toString('utf8');
            }
            chars.push(ch);
          }
        }
      } catch {
        return chars.length === 0 ? null : Buffer.from(chars).toString('utf8');
      }
    },
  };
}

// Format the UTC ISO timestamp the backup-sibling filename embeds. Uses
// the millisecond-precision form (e.g. `2026-06-08T19:42:11.123Z`) so two
// invocations within the same UTC second produce distinct filenames and
// renameSync never silently overwrites a prior backup. The full
// `Date.toISOString()` shape is preserved verbatim — the `.SSS` segment
// is not trimmed.
function formatBackupTimestamp(now: Date): string {
  // The standard library's toISOString() emits the millisecond-precision
  // RFC 3339 form (`YYYY-MM-DDTHH:MM:SS.sssZ`); returning it unchanged is
  // the simplest implementation of option (a) in the
  // h3-backup-timestamp-collision-safe criterion and avoids inventing a
  // bespoke format.
  return now.toISOString();
}

// Compose a temp-file name unique enough that two same-process
// invocations cannot collide. Earlier the suffix was just `<pid>`,
// which collides across retries inside a single long-lived shell
// (same PID for the second invocation) and across vitest workers that
// share a parent PID under `pool: 'threads'`. A six-byte random hex
// token rules out collisions in practice and surfaces leaked debris
// with a distinct name an operator can grep for. The pid stays in
// the name so a `lsof` / `ps` cross-reference still works when a
// long-running operation is interrupted.
function tempSuffixForAtomicWrite(): string {
  return `tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
}

// Atomic write via temp + rename. Writes to
// `<dest>.tmp.<pid>.<random>` first, then renames onto `dest`. The
// temp file shares the parent directory of `dest` (intentionally — the
// sibling-temp design guarantees the rename is intra-filesystem, so
// EXDEV is structurally impossible; a future refactor that moves the
// temp under `os.tmpdir()` would silently re-introduce that bug). The
// temp file is unlinked on a rename failure so a partial write does
// not leave debris; a failure to unlink the debris is surfaced in the
// thrown error message so support can spot the leaked path.
function atomicWriteFile(dest: string, contents: string, mode: number): void {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${path.basename(dest)}.${tempSuffixForAtomicWrite()}`);
  writeFileSync(tmp, contents, { mode });
  try {
    renameSync(tmp, dest);
  } catch (e) {
    let cleanupNote = '';
    try {
      unlinkSync(tmp);
    } catch {
      // Surface the leaked debris path so the operator can clean up
      // manually; previously this branch silently swallowed the
      // failure and the only visible signal was the original throw.
      cleanupNote = ` (debris left at ${tmp})`;
    }
    const inner = e instanceof Error ? e.message : String(e);
    throw new Error(`atomic write to ${dest} failed: ${inner}${cleanupNote}`);
  }
}

// Read a confirmation answer from the supplied stdin adapter. Bare `y`
// (case-insensitive) is a yes; everything else — bare Enter, `N`, `n`,
// anything else — is a no. `null` (EOF) is treated as no.
function readConfirmation(stdin: StdinAdapter): boolean {
  const line = stdin.readLine();
  if (line === null) return false;
  const trimmed = line.trim().toLowerCase();
  return trimmed === 'y' || trimmed === 'yes';
}

// True when `p` exists as a regular file. A directory at the hook path is
// treated as "not a hook" — the spawn would fail anyway, and the surface
// reads more clearly when callers short-circuit on "no file" without
// classifying the directory as something else.
function isFileAt(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// True when `p` is a symlink (not a regular file). Uses `lstatSync` so
// the call inspects the link itself rather than its target. Returns
// false when `p` does not exist at all.
//
// The destructive migrate actions (`--delete`, `--replace`) refuse to
// operate on a symlink: a project hook at `<project>/.claude/hooks/
// gan-confine.sh` symlinked to a path outside the hooks directory
// admits two concrete misuse patterns the framework should not be
// complicit in:
//
//   1. Exfiltration. `runDelete`/`runReplace` would `readFileSync` the
//      hook (which follows the link) and write the target's contents
//      into a backup sibling — turning a routine "clean up your
//      project-tier hook" command into a data-extraction primitive
//      against any file the symlink resolves to.
//
//   2. Surprise. `--delete`'s `unlinkSync` removes the link only (not
//      the target), and `--replace`'s `renameSync` clobbers the link
//      with a regular file (the target survives). Either is arguably
//      reasonable, but neither matches the surface's documented
//      intent ("delete the project-tier hook"), and an operator
//      reading the stdout `to restore: mv <backup> <hook>` line
//      cannot tell that the rollback would not restore the symlink
//      relationship the project shipped.
//
// `--review` is exempt because it is a pure read: the diff against
// the framework template captures the link target's contents, which
// is exactly what an operator wants to see for "is the link's target
// stale?". The structured refusal for the destructive actions tells
// the operator the link is present and points at the manual
// remediation (resolve the link first).
function isSymlinkAt(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Compute the unified-diff line set for `--review`. The implementation
// is a Longest Common Subsequence (LCS) diff built on a standard
// dynamic-programming table, then walked back to emit `-` / `+` /
// context lines in source order. A real LCS is required (not a
// line-index projection) so a single-line insertion early in the file
// produces a single `+` pair plus context lines for the unchanged
// remainder; a naive projection would emit every subsequent line as a
// mismatched -/+ pair, masking the actual drift.
function unifiedDiff(left: string, right: string, leftLabel: string, rightLabel: string): string {
  const a = left.split('\n');
  const b = right.split('\n');
  const lines: string[] = [];
  lines.push(`--- ${leftLabel}`);
  lines.push(`+++ ${rightLabel}`);
  // Emit a single hunk header. The simple form serves the
  // operator-facing review use case; a future enhancement could compute
  // proper @@ hunk ranges, but the inline call site does not require
  // it.
  lines.push(`@@ -1,${a.length} +1,${b.length} @@`);
  // Build the LCS length table. `dp[i][j]` is the length of the LCS of
  // `a[0..i)` and `b[0..j)`. The table is O((|a|+1)*(|b|+1)) but the
  // confinement hook templates compared here are short (~200 lines), so
  // a few tens of thousands of integer cells is well within budget.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) {
    const row = new Array<number>(m + 1).fill(0);
    dp.push(row);
  }
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        const up = dp[i - 1]![j]!;
        const left = dp[i]![j - 1]!;
        dp[i]![j] = up >= left ? up : left;
      }
    }
  }
  // Walk back through the table to produce the edit script in reverse,
  // then reverse the collected segments to emit them in source order.
  type Op = { kind: 'ctx' | 'del' | 'add'; text: string };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ kind: 'ctx', text: a[i - 1]! });
      i -= 1;
      j -= 1;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) {
      ops.push({ kind: 'del', text: a[i - 1]! });
      i -= 1;
    } else {
      ops.push({ kind: 'add', text: b[j - 1]! });
      j -= 1;
    }
  }
  while (i > 0) {
    ops.push({ kind: 'del', text: a[i - 1]! });
    i -= 1;
  }
  while (j > 0) {
    ops.push({ kind: 'add', text: b[j - 1]! });
    j -= 1;
  }
  ops.reverse();
  for (const op of ops) {
    if (op.kind === 'ctx') lines.push(` ${op.text}`);
    else if (op.kind === 'del') lines.push(`-${op.text}`);
    else lines.push(`+${op.text}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * CLI entry point for `gan hooks migrate`.
 *
 * @param parsed parsed argv. Exactly one of `--delete`, `--replace`, or
 *   `--review` is required; honours `--yes` for non-interactive
 *   confirmation. Reads `--project-root <path>` via the standard
 *   {@link resolveProjectRoot} helper.
 * @param options test-only seam for the stdin adapter and the clock. See
 *   {@link MigrateOptions}.
 * @returns a {@link CommandResult}. Exit codes: `EXIT_OK` on success;
 *   `EXIT_VALIDATION` (`2`) when a destructive action is invoked without
 *   `--yes` on a non-TTY stdin, when more than one action is supplied,
 *   when no action is supplied, or when a destructive operation fails
 *   filesystem semantics. Side effects: `--delete` and `--replace` write
 *   the backup sibling and then mutate the hook path; `--review` is a
 *   pure read and writes nothing.
 */
export async function run(
  parsed: ParsedArgs,
  options: MigrateOptions = {},
): Promise<CommandResult> {
  const wantDelete = parsed.flags['delete'] === true;
  const wantReplace = parsed.flags['replace'] === true;
  const wantReview = parsed.flags['review'] === true;
  const yesFlag = parsed.flags['yes'] === true;

  // Argument errors → `EXIT_BAD_ARGS`. The previous revision collapsed
  // these onto `EXIT_VALIDATION` (2), which made a CI gate unable to
  // distinguish "the operator typed the command wrong" from "the
  // operator's hook needs migration." The split keeps the
  // sysexits-style classification a script can branch on.
  const selected = [wantDelete, wantReplace, wantReview].filter(Boolean).length;
  if (selected !== 1) {
    const msg =
      selected === 0
        ? 'Error: gan hooks migrate requires exactly one of --delete / --replace / --review.\n'
        : 'Error: gan hooks migrate accepts exactly one of --delete / --replace / --review (got more than one).\n';
    return { stdout: '', stderr: msg, code: EXIT_BAD_ARGS };
  }

  const projectRootFlag = typeof parsed.flags['project-root'] === 'string'
    ? (parsed.flags['project-root'] as string)
    : undefined;
  let projectRootPath: string;
  try {
    projectRootPath = resolveProjectRoot(projectRootFlag).path;
  } catch (e) {
    // `--project-root` resolution failures are also argument errors:
    // the operator pointed `gan` at a non-existent directory.
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: '', stderr: `Error: ${msg}\n`, code: EXIT_BAD_ARGS };
  }

  const hooksDir = path.join(projectRootPath, '.claude', 'hooks');
  const hookPath = path.join(hooksDir, 'gan-confine.sh');
  const stdin = options.stdin ?? defaultStdinAdapter();
  const now = options.now ? options.now() : new Date();

  if (wantReview) {
    return runReview(hookPath);
  }

  // Destructive actions: enforce the confirmation contract.
  if (!yesFlag) {
    if (!stdin.isTTY) {
      // Non-TTY stdin without `--yes`: fail closed with a structured
      // error the operator can act on by re-running with `--yes`.
      const payload = JSON.stringify({
        code: 'GanHooksMigrateConfirmationRequired',
        subReason: 'confirmationRequired',
        message:
          'gan hooks migrate: refusing on non-TTY stdin without --yes; ' +
          're-run with --yes to bypass the interactive confirmation.',
      });
      return {
        stdout: '',
        stderr: payload + '\n',
        code: EXIT_VALIDATION,
      };
    }
    // TTY confirmation prompt: surface the action and read one line.
    const promptLines: string[] = [];
    if (wantDelete) {
      promptLines.push(
        `About to delete ${hookPath} (a timestamped .gan-bak.<utc-iso> backup sibling is written first).`,
      );
    } else {
      promptLines.push(
        `About to replace ${hookPath} with the framework current template (a timestamped .gan-bak.<utc-iso> backup sibling is written first).`,
      );
    }
    promptLines.push('Continue? [y/N] ');
    // Write prompt to stderr so `--json`-style callers piping stdout to
    // jq still see the prompt; the helper does not invoke writeOut here
    // because the prompt is interactive and must flush synchronously.
    process.stderr.write(promptLines.join('\n'));
    const confirmed = readConfirmation(stdin);
    if (!confirmed) {
      return {
        stdout: '',
        stderr: 'gan hooks migrate: cancelled.\n',
        code: EXIT_VALIDATION,
      };
    }
  }

  if (wantDelete) {
    return runDelete(hookPath, now);
  }
  return runReplace(hooksDir, hookPath, now);
}

// Structured stderr payload for the symlink refusal. The diagnostic
// names the `subReason` so a JSON-piping caller can branch on it, and
// surfaces the manual remediation (the operator decides whether the
// link is intentional and resolves it themselves) so the framework
// never silently follows a symlink and writes through it.
function symlinkRefusalPayload(hookPath: string, action: 'delete' | 'replace'): string {
  return JSON.stringify({
    code: 'GanHooksMigrateProjectHookIsSymlink',
    subReason: 'projectHookIsSymlink',
    message:
      `gan hooks migrate --${action}: refusing to operate on ${hookPath} ` +
      `because it is a symbolic link. Following the link could read or ` +
      `clobber a file outside the project's .claude/hooks/ directory. ` +
      `Resolve the link manually (inspect the target with \`readlink ${hookPath}\`, ` +
      `replace the link with a regular file, or remove the link) and re-run.`,
  });
}

function runReview(hookPath: string): CommandResult {
  if (!isFileAt(hookPath)) {
    return {
      stdout: `no project-tier hook present at ${hookPath}; nothing to diff\n`,
      stderr: '',
      code: EXIT_OK,
    };
  }
  const current = readFileSync(hookPath, 'utf8');
  let template: string;
  try {
    template = renderCurrentTemplate();
  } catch (e) {
    // Template-resolution failures are framework-internal IO problems
    // (package.json unreadable, template missing); they are not the
    // operator's input being wrong, so they map to EXIT_GENERIC.
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: '', stderr: `Error: ${msg}\n`, code: EXIT_GENERIC };
  }
  const diff = unifiedDiff(current, template, hookPath, '<framework current template>');
  return { stdout: diff, stderr: '', code: EXIT_OK };
}

function runDelete(hookPath: string, now: Date): CommandResult {
  if (!isFileAt(hookPath)) {
    return {
      stdout: `no project-tier hook present at ${hookPath}; nothing to delete\n`,
      stderr: '',
      code: EXIT_OK,
    };
  }
  // Symlink guard: see {@link isSymlinkAt} for the rationale. The
  // refusal is EXIT_VALIDATION rather than EXIT_BAD_ARGS because the
  // operator's command was syntactically correct; the project tree
  // is what fails the migrate's input contract.
  if (isSymlinkAt(hookPath)) {
    return {
      stdout: '',
      stderr: symlinkRefusalPayload(hookPath, 'delete') + '\n',
      code: EXIT_VALIDATION,
    };
  }
  const original = readFileSync(hookPath);
  // Capture the source hook's mode bits BEFORE the unlink so the backup
  // sibling carries the same permissions and the documented `mv backup
  // hook` rollback restores a runnable hook. The mask `& 0o7777` keeps
  // the setuid/setgid/sticky bits along with the standard rwx triples
  // and discards the file-type bits Node's stat reports above 0o7777.
  const sourceMode = statSync(hookPath).mode & 0o7777;
  const backupPath = composeBackupPath(hookPath, now);
  try {
    // Atomic backup-then-unlink: write the backup via temp+rename FIRST so
    // a failure between write and rename leaves the original intact and
    // the operator can re-run. Only after the backup rename succeeds does
    // the unlink fire.
    atomicWriteBuffer(backupPath, original, sourceMode);
    unlinkSync(hookPath);
  } catch (e) {
    // Filesystem failures (ENOSPC, EACCES, EBUSY, EROFS) are
    // operational, not validation: they tell the operator the
    // environment can't satisfy the request rather than the request
    // being malformed. Mapped to EXIT_GENERIC so a CI gate can
    // distinguish them from "stale hook detected, fix me" outcomes.
    const msg = e instanceof Error ? e.message : String(e);
    return {
      stdout: '',
      stderr: `Error: gan hooks migrate --delete failed: ${msg}\n`,
      code: EXIT_GENERIC,
    };
  }
  const stdout =
    `deleted ${hookPath}\n` +
    `backup at ${backupPath}\n` +
    `to restore: mv ${backupPath} ${hookPath}\n`;
  return { stdout, stderr: '', code: EXIT_OK };
}

function runReplace(hooksDir: string, hookPath: string, now: Date): CommandResult {
  let template: string;
  try {
    template = renderCurrentTemplate();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: '', stderr: `Error: ${msg}\n`, code: EXIT_GENERIC };
  }

  // Create-on-demand parent directory. `mkdir -p`-equivalent; the
  // recursive flag handles the case where `<project>/.claude/` exists but
  // `hooks/` does not, as well as the case where neither exists.
  try {
    mkdirSync(hooksDir, { recursive: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      stdout: '',
      stderr: `Error: gan hooks migrate --replace could not create ${hooksDir}: ${msg}\n`,
      code: EXIT_GENERIC,
    };
  }

  const present = isFileAt(hookPath);
  if (!present) {
    try {
      // Create path: no prior content, so no backup line in the message.
      atomicWriteFile(hookPath, template, 0o755);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        stdout: '',
        stderr: `Error: gan hooks migrate --replace failed: ${msg}\n`,
        code: EXIT_GENERIC,
      };
    }
    return {
      stdout: `created ${hookPath}\n`,
      stderr: '',
      code: EXIT_OK,
    };
  }

  // Symlink guard: refuse to overwrite a symlink the same way
  // `runDelete` refuses to unlink one — see {@link isSymlinkAt}.
  if (isSymlinkAt(hookPath)) {
    return {
      stdout: '',
      stderr: symlinkRefusalPayload(hookPath, 'replace') + '\n',
      code: EXIT_VALIDATION,
    };
  }

  // Replace path: backup-then-overwrite. The temp+rename pattern fires
  // for both the backup sibling and the replacement, so a partial state
  // on disk is impossible: the backup is renamed onto its final path
  // before the original hook is overwritten, and the replacement is
  // renamed onto the original path in one atomic step.
  const original = readFileSync(hookPath);
  // Capture the source hook's mode bits BEFORE the overwrite so the
  // backup sibling carries the same permissions; see the matching
  // comment in runDelete above for the rationale.
  const sourceMode = statSync(hookPath).mode & 0o7777;
  const backupPath = composeBackupPath(hookPath, now);
  try {
    atomicWriteBuffer(backupPath, original, sourceMode);
    atomicWriteFile(hookPath, template, 0o755);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      stdout: '',
      stderr: `Error: gan hooks migrate --replace failed: ${msg}\n`,
      code: EXIT_GENERIC,
    };
  }
  const stdout =
    `replaced ${hookPath}\n` +
    `backup at ${backupPath}\n` +
    `to restore: mv ${backupPath} ${hookPath}\n`;
  return { stdout, stderr: '', code: EXIT_OK };
}

// Compose the backup sibling path under `<hookDir>/` for the given
// timestamp. Exported as a module-private helper so the delete and
// replace code paths produce identical filenames for matching test
// fixtures.
function composeBackupPath(hookPath: string, now: Date): string {
  const dir = path.dirname(hookPath);
  const filename = `${BACKUP_SIBLING_PREFIX}${formatBackupTimestamp(now)}`;
  return path.join(dir, filename);
}

// Atomic-write a Buffer (rather than a string). The text helper above
// takes a mode argument; the binary helper does too because the backup
// sibling MUST preserve the source hook's executable bit so the
// documented `mv <backup> <hook>` rollback restores a runnable hook. A
// missing mode argument would default Node's `writeFileSync` to `0o666 &
// umask` (typically `0o644` on a standard operator umask) and the
// rollback would produce a non-executable hook that Claude Code skips
// silently or rejects with EACCES. Shares the temp-name and
// EXDEV-by-construction rationale with `atomicWriteFile`; see its
// comment for why the temp lives next to the dest.
function atomicWriteBuffer(dest: string, contents: Buffer, mode: number): void {
  const dir = path.dirname(dest);
  const tmp = path.join(dir, `${path.basename(dest)}.${tempSuffixForAtomicWrite()}`);
  writeFileSync(tmp, contents, { mode });
  try {
    renameSync(tmp, dest);
  } catch (e) {
    let cleanupNote = '';
    try {
      unlinkSync(tmp);
    } catch {
      cleanupNote = ` (debris left at ${tmp})`;
    }
    const inner = e instanceof Error ? e.message : String(e);
    throw new Error(`atomic write to ${dest} failed: ${inner}${cleanupNote}`);
  }
}

// Re-export the helpers that the tests legitimately need to assert
// against, behind names that are clearly internal-but-exposed-for-tests.
// Keeping the underscores prefix advertises the seam without exporting
// the helpers as public CLI API.

/**
 * Test-only seam: produce the deterministic backup-sibling filename for a
 * given timestamp. Underscore-prefixed to advertise the seam.
 */
export function _composeBackupPathForTests(hookPath: string, now: Date): string {
  return composeBackupPath(hookPath, now);
}

/**
 * Test-only seam: existence check for the hook file. Underscore-prefixed
 * to advertise the seam.
 */
export function _isFileAtForTests(p: string): boolean {
  return isFileAt(p);
}

