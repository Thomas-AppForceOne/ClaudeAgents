/**
 * `gan hooks status` — diagnose the install state of the `gan-confine.sh`
 * write-confinement hook and the active-run confinement zones.
 *
 * The hook can exist at two tiers: a user-tier copy authored by the framework
 * (and stamped with the version that wrote it) and an optional project-tier
 * override that, when present, takes precedence. The command reports both,
 * flags a stale user-tier hook (authored version != current framework
 * version), and flags a legacy project override that still references the
 * retired `.gan/` zone layout. It also reports the per-run env vars
 * (`GAN_RUN_ID` / `GAN_WORKTREE` / `GAN_RUN_DIR`) the framework exports while a
 * run is active.
 *
 * This is a pure diagnostic: it only reads. {@link collectStatus} is the
 * testable core; {@link run} wraps it so any unexpected failure degrades to a
 * conservative "nothing installed" report rather than an error exit.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitJson } from '../lib/json-output.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Result contract shared by every CLI command handler.
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Status of the user-tier (framework-authored) confinement hook.
 *
 * @property path absolute path where the user-tier hook lives.
 * @property present whether that file exists and was readable.
 * @property authoredVersion the framework version parsed from the hook's
 *   header, or `null` when absent or unparseable.
 * @property current `true` only when both the authored and current framework
 *   versions are known and equal (i.e. the hook is up to date).
 */
export interface UserTierStatus {
  path: string;

  present: boolean;

  authoredVersion: string | null;

  current: boolean;
}

/**
 * Status of an optional project-tier hook override.
 *
 * @property path absolute path where a project-tier override would live.
 * @property present whether such an override exists.
 * @property legacy whether a present override still references the retired
 *   `.gan/` zone layout (and not the current `.gan-state/`), suggesting it
 *   should be deleted.
 */
export interface ProjectTierStatus {
  path: string;

  present: boolean;

  legacy: boolean;
}

/**
 * The active-run confinement zone env vars.
 *
 * @property runId `GAN_RUN_ID`, or `null` when not inside a run.
 * @property worktree `GAN_WORKTREE`, or `null` when unset.
 * @property runDir `GAN_RUN_DIR`, or `null` when unset.
 *
 * Invariant: when `runId` is `null` the other two are forced to `null` as well
 * (no run means no zones), regardless of stray env values.
 */
export interface RunZonesStatus {
  runId: string | null;

  worktree: string | null;

  runDir: string | null;
}

/**
 * Full, serialisable status payload (the `--json` shape).
 *
 * @property frameworkVersion the current framework version, or `'unknown'`.
 * @property userTier user-tier hook status.
 * @property projectTier project-tier override status.
 * @property runZones active-run zone env vars.
 * @property projectTierTakesPrecedence mirrors `projectTier.present` — a
 *   present project override wins over the user-tier hook.
 * @property legacyDeletionHint `true` when a project override is present *and*
 *   legacy, the precise condition under which the deletion hint is shown.
 */
export interface HooksStatusOutput {
  frameworkVersion: string;
  userTier: UserTierStatus;
  projectTier: ProjectTierStatus;

  runZones: RunZonesStatus;

  projectTierTakesPrecedence: boolean;

  legacyDeletionHint: boolean;
}

/**
 * Resolve the installed package root relative to this compiled module.
 *
 * Anchored to this file's location (three levels up from `dist/cli/commands/`),
 * not the process cwd, so it is correct wherever `gan` is invoked from.
 */
function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..', '..');
}

/**
 * Read the current framework version from the package's `package.json`.
 *
 * Honours `GAN_PACKAGE_ROOT_OVERRIDE` (test seam) over the resolved root.
 *
 * @returns the version string, or `null` when the file is missing/unreadable
 *   or has no string `version`. Never throws — a missing version simply leaves
 *   the staleness check undecidable.
 */
async function readFrameworkVersion(): Promise<string | null> {
  const root = process.env.GAN_PACKAGE_ROOT_OVERRIDE ?? packageRoot();
  const pkgPath = path.join(root, 'package.json');
  try {
    const raw = await readFile(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

/**
 * Read a hook file's text.
 *
 * @param hookPath absolute path to the hook script.
 * @returns the file contents, or `null` when it does not exist or cannot be
 *   read. Never throws — absence is the common, expected case.
 */
async function readHookText(hookPath: string): Promise<string | null> {
  try {
    return await readFile(hookPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse the framework version stamped in a hook's header.
 *
 * Only the first {@link HEADER_LINE_LIMIT} lines are scanned — the version line
 * is a header convention, so bounding the scan keeps a huge or hostile file
 * from being walked end to end. Matches an optional semver pre-release/build
 * suffix.
 *
 * @param content the full hook text.
 * @returns the matched version string, or `null` when no version line is found
 *   within the header window.
 */
export function parseAuthoredVersion(content: string): string | null {
  const HEADER_LINE_LIMIT = 50;
  const lines = content.split('\n', HEADER_LINE_LIMIT + 1);
  const re = /Source of truth:\s*ClaudeAgents framework,\s*version\s+([0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)/;
  for (let i = 0; i < Math.min(lines.length, HEADER_LINE_LIMIT); i++) {
    const m = re.exec(lines[i]!);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * Decide whether a project-tier hook is a legacy artifact.
 *
 * @param content the hook text.
 * @returns `true` only when the hook references the retired `.gan/` zone layout
 *   and does *not* reference the current `.gan-state/` layout. The current-zone
 *   check wins: a hook mentioning both is treated as current, never legacy, so
 *   an up-to-date hook is never mistaken for a deletion candidate.
 */
export function isLegacyProjectHook(content: string): boolean {
  const referencesCurrentZone = content.includes('.gan-state/');
  if (referencesCurrentZone) return false;

  const referencesLegacyZone = content.includes('.gan/');
  return referencesLegacyZone;
}

/**
 * Abbreviate a path that lives under the user's home to a `~`-prefixed form
 * for display.
 *
 * @param absPath the absolute path to display.
 * @param home the user's home directory.
 * @returns `~`-relative form when `absPath` equals or is nested under `home`
 *   (the `home + sep` guard avoids mistaking a sibling like `/home/foo-bar`
 *   for being inside `/home/foo`); otherwise `absPath` unchanged.
 */
function displayUserPath(absPath: string, home: string): string {
  if (home && (absPath === home || absPath.startsWith(home + path.sep))) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/**
 * Read an env var, normalising absent/empty to `null`.
 *
 * @returns the value when it is a non-empty string, else `null` — so an empty
 *   `GAN_*` var is treated as unset rather than a meaningful value.
 */
function readEnvOrNull(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Collect the active-run confinement zones from the environment.
 *
 * @param env the environment to read.
 * @returns a {@link RunZonesStatus}. When `GAN_RUN_ID` is unset the worktree
 *   and run-dir are forced to `null` without even reading them — outside a run
 *   those vars have no meaning, so this enforces the all-or-nothing invariant.
 */
function collectRunZones(env: NodeJS.ProcessEnv): RunZonesStatus {
  const runId = readEnvOrNull(env, 'GAN_RUN_ID');
  if (runId === null) {
    return { runId: null, worktree: null, runDir: null };
  }
  return {
    runId,
    worktree: readEnvOrNull(env, 'GAN_WORKTREE'),
    runDir: readEnvOrNull(env, 'GAN_RUN_DIR'),
  };
}

/**
 * Gather the full hook status. The testable core of this command.
 *
 * @param cwd the project directory (where a project-tier override would live).
 * @param home the user's home directory (where the user-tier hook lives).
 * @param env the environment to read run-zone vars from (defaults to
 *   `process.env`).
 * @returns the assembled {@link HooksStatusOutput}. The framework version and
 *   both hook texts are read concurrently. A missing framework version becomes
 *   `'unknown'`, which forces `userTier.current` to `false` (an undecidable
 *   staleness check errs toward "not current"). May reject if an underlying
 *   read rejects in a way the helpers do not absorb; {@link run} catches that.
 */
export async function collectStatus(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HooksStatusOutput> {
  const userPath = path.join(home, '.claude', 'hooks', 'gan-confine.sh');
  const projectPath = path.join(cwd, '.claude', 'hooks', 'gan-confine.sh');

  // Read the version and both hook files concurrently — they are independent.
  const [frameworkVersion, userText, projectText] = await Promise.all([
    readFrameworkVersion(),
    readHookText(userPath),
    readHookText(projectPath),
  ]);

  const authoredVersion = userText !== null ? parseAuthoredVersion(userText) : null;
  const userTier: UserTierStatus = {
    path: userPath,
    present: userText !== null,
    authoredVersion,
    current:
      authoredVersion !== null &&
      frameworkVersion !== null &&
      authoredVersion === frameworkVersion,
  };

  const projectPresent = projectText !== null;
  const legacy = projectPresent ? isLegacyProjectHook(projectText) : false;
  const projectTier: ProjectTierStatus = {
    path: projectPath,
    present: projectPresent,
    legacy,
  };

  return {
    frameworkVersion: frameworkVersion ?? 'unknown',
    userTier,
    projectTier,
    runZones: collectRunZones(env),
    // A present project override always wins over the user-tier hook.
    projectTierTakesPrecedence: projectPresent,
    // The deletion hint fires only for a present *and* legacy override.
    legacyDeletionHint: projectPresent && legacy,
  };
}

/**
 * Render the hook status for human (non-JSON) output.
 *
 * @param out the collected status.
 * @param home the user's home, used to abbreviate user-tier paths via
 *   {@link displayUserPath}.
 * @returns a multi-section report (trailing newline): the user-tier hook
 *   (with install / staleness guidance), the project-tier override (only when
 *   present, with the legacy-deletion hint when applicable), and the
 *   active-run zones (or guidance that no run is active).
 */
function renderHuman(out: HooksStatusOutput, home: string): string {
  const lines: string[] = [];

  const userDisplay = displayUserPath(out.userTier.path, home);
  lines.push(`User-tier framework hook: ${userDisplay}`);
  if (out.userTier.present) {
    if (out.userTier.authoredVersion === null) {
      lines.push(
        '  Authored version: unknown (header has no parseable version line).',
      );
    } else if (out.userTier.current) {
      lines.push(`  Authored by ClaudeAgents ${out.userTier.authoredVersion} — current.`);
    } else {
      lines.push(
        `  Authored by ClaudeAgents ${out.userTier.authoredVersion} — stale ` +
          `(the framework is now ${out.frameworkVersion}). Re-run \`install.sh\` ` +
          'from the framework repo root to refresh it.',
      );
    }
  } else {
    lines.push('  Not installed.');
    lines.push(
      '  Run `install.sh` from the framework repo root to install the ' +
        'user-tier confinement hook.',
    );
  }

  if (out.projectTier.present) {
    lines.push('');
    lines.push(`Project-tier override: ${out.projectTier.path}`);
    lines.push(
      '  Detected. Project-tier overrides take precedence over the user-tier hook.',
    );
    if (out.legacyDeletionHint) {
      lines.push('  This file references `.gan/` (legacy zone layout retired in v0.0.x).');
      lines.push("  If you don't have a deliberate reason to keep this override, delete it");
      lines.push("  (`rm .claude/hooks/gan-confine.sh`) — the framework's current user-tier");
      lines.push('  hook will then apply.');
    }
  }

  lines.push('');
  lines.push('Active-run confinement zones:');
  if (out.runZones.runId === null) {
    lines.push('  Not in a run. `GAN_RUN_ID`, `GAN_WORKTREE`, and `GAN_RUN_DIR` are unset.');
    lines.push('  The framework exports these at sprint start; the hook confines writes to');
    lines.push('  the worktree and the run directory only while a run is active.');
  } else {
    lines.push(`  Run id (\`GAN_RUN_ID\`): ${out.runZones.runId}`);
    lines.push(
      `  Worktree (\`GAN_WORKTREE\`): ${
        out.runZones.worktree === null ? 'unset' : displayUserPath(out.runZones.worktree, home)
      }`,
    );
    lines.push(
      `  Run directory (\`GAN_RUN_DIR\`): ${
        out.runZones.runDir === null ? 'unset' : displayUserPath(out.runZones.runDir, home)
      }`,
    );
  }

  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan hooks status`.
 *
 * @param parsed parsed argv; honours `--json`. Operates on the current working
 *   directory and the user's home — there is no `--project-root`.
 * @returns a {@link CommandResult}; always exit {@link EXIT_OK}. Never throws:
 *   if {@link collectStatus} rejects, the catch substitutes a conservative
 *   "nothing installed / not in a run" report so a diagnostic command can
 *   still produce useful output instead of failing.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
  const cwd = process.cwd();
  const home = os.homedir();

  let out: HooksStatusOutput;
  try {
    out = await collectStatus(cwd, home, process.env);
  } catch {
    // Degrade gracefully: a diagnostic should still report *something* rather
    // than erroring, so an unexpected failure becomes an all-absent status.
    out = {
      frameworkVersion: 'unknown',
      userTier: {
        path: path.join(home, '.claude', 'hooks', 'gan-confine.sh'),
        present: false,
        authoredVersion: null,
        current: false,
      },
      projectTier: {
        path: path.join(cwd, '.claude', 'hooks', 'gan-confine.sh'),
        present: false,
        legacy: false,
      },
      runZones: { runId: null, worktree: null, runDir: null },
      projectTierTakesPrecedence: false,
      legacyDeletionHint: false,
    };
  }

  const stdout = wantJson ? emitJson(out) : renderHuman(out, home);
  return { stdout, stderr: '', code: EXIT_OK };
}
