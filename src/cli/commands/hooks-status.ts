/**
 * H1 sprint 4 — `gan hooks status [--json]`.
 *
 * Reports the framework's confinement-hook state across the two tiers
 * Claude Code resolves between:
 *
 *   - user-tier:    `~/.claude/hooks/gan-confine.sh` (framework-owned; the
 *                   path `install.sh` writes per H1).
 *   - project-tier: `<cwd>/.claude/hooks/gan-confine.sh` (optional override;
 *                   the project's responsibility, never touched by install).
 *
 * This is a FILESYSTEM-REPORTING command (per the H1 digest and the R3
 * note that `gan hooks status` reads the user's filesystem rather than the
 * Configuration API). It therefore:
 *   - reads `~/.claude/hooks/` + `<cwd>/.claude/hooks/` + `package.json`
 *     directly via `node:fs`/`node:os`/`node:path`, modeled on
 *     `src/cli/commands/version.ts` — it does NOT route through an R1
 *     config-server read entry (`runRead`/`listModules`/etc.), so it works
 *     in a directory with no resolvable framework config; and
 *   - never `--project-root`-gates the report.
 *
 * SECURITY POSTURE — hook files are treated strictly as untrusted DATA.
 * The command never executes, sources, evals, or interpolates any hook
 * file's bytes. Legacy detection is a pure content scan (substring match
 * on the decoded text); the authoring-version parse is a regex over the
 * header. Large / binary / NUL-byte / shell-injection-bait content is
 * classified and reporting continues — it can neither crash the command
 * nor trigger code execution. Mirrors the confinement hook template's
 * own never-execute-untrusted-bytes posture.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { emitJson } from '../lib/json-output.js';
import { EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * The user-tier authoring version, as parsed from the hook header. `null`
 * when the hook is present but its header carries no parseable
 * `version <semver>` line (corrupted / hand-edited header) — reported as
 * unknown, never a crash.
 */
export interface UserTierStatus {
  /** Absolute, home-resolved path to the user-tier hook. */
  path: string;
  /** Whether the file exists and was readable. */
  present: boolean;
  /** Authoring framework version parsed from the header, or null if unparseable. */
  authoredVersion: string | null;
  /** True when `authoredVersion` equals the current framework version. */
  current: boolean;
}

export interface ProjectTierStatus {
  /** Absolute path to the project-tier hook (whether or not it exists). */
  path: string;
  /** Whether the file exists and was readable. */
  present: boolean;
  /**
   * True when present content references the retired `.gan/` zone AND does
   * NOT reference the current `.gan-state/` zone token. Only meaningful
   * when `present` is true.
   */
  legacy: boolean;
}

/**
 * The two F7 confinement zones the orchestrator exports at sprint start, as
 * read from the environment when `gan hooks status` runs. Both are reported —
 * resolved when set, `null` when absent (invoked outside a run). The command
 * never throws on absence; an unset zone is reported, never fatal.
 */
export interface RunZonesStatus {
  /**
   * The run-id of the active run (`GAN_RUN_ID`), or `null` when the command
   * is invoked outside a run. When `null`, the zone values below are reported
   * as unset regardless of whether the zone env vars happen to be present.
   */
  runId: string | null;
  /** The resolved worktree (`GAN_WORKTREE`), or `null` when unset/empty. */
  worktree: string | null;
  /** The central-store run directory (`GAN_RUN_DIR`), or `null` when unset/empty. */
  runDir: string | null;
}

export interface HooksStatusOutput {
  /** The current framework version (read from package.json). */
  frameworkVersion: string;
  userTier: UserTierStatus;
  projectTier: ProjectTierStatus;
  /**
   * The two F7 confinement zones the active run exports (GAN_WORKTREE /
   * GAN_RUN_DIR), reported as resolved or unset. Replaces the retired
   * project-root-derived run-path report.
   */
  runZones: RunZonesStatus;
  /**
   * True when the project-tier hook is present (it always takes precedence
   * over the user-tier hook when present).
   */
  projectTierTakesPrecedence: boolean;
  /**
   * True when a legacy-deletion hint should be surfaced (project-tier hook
   * present AND its content matches the known-legacy `.gan/` layout).
   */
  legacyDeletionHint: boolean;
}

/**
 * Locate the framework's package root. From
 * `dist/cli/commands/hooks-status.js` this is three levels up
 * (`commands/` → `cli/` → `dist/` → `<root>`). Same shape from
 * `src/cli/commands/hooks-status.ts` under vitest. Identical to
 * `version.ts`'s `packageRoot()` — the version is read from
 * `package.json` at runtime, never a hardcoded constant.
 */
function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..', '..');
}

/**
 * Read the current framework version from `package.json`. Mirrors
 * `version.ts`'s `readServerVersion()` shape (no string-literal version).
 * The optional `GAN_PACKAGE_ROOT_OVERRIDE` test seam is honoured so the
 * spawned-binary tests can pin a known package root.
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
 * Read a candidate hook file as UTF-8 text. Returns `null` when the file
 * is absent (ENOENT), the directory is missing, the path is unreadable, or
 * any other I/O error occurs — every such case is treated as ABSENCE, not
 * a fatal error. Decoding is lossy
 * UTF-8 (`utf8`), so binary / NUL-byte content yields a string that the
 * pure content scan can classify without crashing.
 */
async function readHookText(hookPath: string): Promise<string | null> {
  try {
    return await readFile(hookPath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Parse the framework version that authored a hook from its header line:
 *
 *   # Source of truth: ClaudeAgents framework, version <semver>.
 *
 * (the confinement hook template's `__GAN_FRAMEWORK_VERSION__` slot,
 * substituted at install). The match is a pure regex over the decoded text — the bytes are
 * never executed. Returns `null` when no parseable `version <semver>` line
 * is found (corrupted / hand-edited / non-framework header), so the caller
 * reports the authored version as unknown rather than crashing.
 *
 * The semver shape is permissive (`\d+\.\d+\.\d+` plus an optional
 * pre-release / build tail) so a future framework version string still
 * parses; anything wholly unparseable degrades to `null`.
 */
export function parseAuthoredVersion(content: string): string | null {
  // Scan line-by-line so a huge file does not force a single catastrophic
  // regex over megabytes; the header is within the first handful of lines.
  // We still cap the scan defensively.
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
 * Classify whether project-tier hook content matches the known-legacy
 * layout. Legacy is defined OBJECTIVELY by content tokens (never by reading
 * version metadata from the project hook, which is project-owned and may
 * carry none):
 *
 *   - the content references the retired `.gan/` zone (a `.gan/` path or a
 *     `*.gan/*` glob, per the spec's legacy illustration), AND
 *   - the content does NOT reference the current `.gan-state/` zone token.
 *
 * Pure substring scan on the decoded text — no execution, no interpolation.
 * The `.gan-state/` test is checked first because `.gan-state/` itself
 * contains the substring `.gan` (with a trailing `-state`), so a current
 * hook must not be mis-flagged: the presence of the current token alone
 * clears the legacy verdict.
 */
export function isLegacyProjectHook(content: string): boolean {
  const referencesCurrentZone = content.includes('.gan-state/');
  if (referencesCurrentZone) return false;
  // `.gan/` as a path segment, or the spec's `*.gan/*` legacy glob.
  const referencesLegacyZone = content.includes('.gan/');
  return referencesLegacyZone;
}

/** Tilde-collapse a home-rooted absolute path for human display. */
function displayUserPath(absPath: string, home: string): string {
  if (home && (absPath === home || absPath.startsWith(home + path.sep))) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

/**
 * Read a string environment value, returning `null` for an absent OR empty
 * value (an empty zone is treated as unset, mirroring the hook's own
 * `[ -z … ]` gate). Pure read of the supplied env map — no execution.
 */
function readEnvOrNull(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Resolve the F7 run zones from the environment. The two zone values are
 * meaningful only inside an active run: when `GAN_RUN_ID` is unset/empty the
 * command is running outside a run, so the zones are reported as unset even
 * if the env happens to carry stray values. Never throws.
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

/** Build the structured report. Never throws. */
export async function collectStatus(
  cwd: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HooksStatusOutput> {
  const userPath = path.join(home, '.claude', 'hooks', 'gan-confine.sh');
  const projectPath = path.join(cwd, '.claude', 'hooks', 'gan-confine.sh');

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
    projectTierTakesPrecedence: projectPresent,
    legacyDeletionHint: projectPresent && legacy,
  };
}

/**
 * Render the human-readable report. Matches the H1 § Examples shape:
 *
 *   User-tier framework hook: ~/.claude/hooks/gan-confine.sh
 *     Authored by ClaudeAgents 0.1.0 — current.
 *
 *   Project-tier override: ./.claude/hooks/gan-confine.sh
 *     Detected. Project-tier overrides take precedence over the user-tier hook.
 *     This file references `.gan/` (legacy zone layout retired in v0.0.x).
 *     If you don't have a deliberate reason to keep this override, delete it
 *     (`rm .claude/hooks/gan-confine.sh`) — the framework's current user-tier
 *     hook will then apply.
 *
 * A trailing "Active-run confinement zones:" section reports the two F7
 * zones the orchestrator exports (`GAN_WORKTREE` / `GAN_RUN_DIR`) for the
 * active run, or notes that the command is running outside a run.
 *
 * Every user-visible string obeys F4 prose discipline: shell remediation
 * (`rm <path>`, run `install.sh`), refers to "the framework" / "ClaudeAgents",
 * and contains no bare `node`/`npm`/`Node`/`MCP server` tokens.
 */
function renderHuman(out: HooksStatusOutput, home: string): string {
  const lines: string[] = [];

  // --- User tier ----------------------------------------------------------
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

  // --- Project tier -------------------------------------------------------
  // Only emit a project-tier section when an override is actually present.
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

  // --- Run zones (F7) -----------------------------------------------------
  // The two confinement zones the orchestrator exports for the active run.
  // Reported as resolved when set, or unset when invoked outside a run.
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
 * Run `gan hooks status`. Always returns a `CommandResult`; never throws.
 * Reads the filesystem (no Configuration API), classifies hook content as
 * untrusted data, and emits either the human report or the structured JSON
 * surface (via the single-call-site `emitJson` → `stableStringify`).
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
  const cwd = process.cwd();
  const home = os.homedir();

  // collectStatus never throws; the absence/robustness paths are handled
  // inside it. We still guard defensively so an unexpected error degrades
  // to a clean report rather than a stack trace on stderr.
  let out: HooksStatusOutput;
  try {
    out = await collectStatus(cwd, home, process.env);
  } catch {
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
