/**
 * `gan hooks status` — diagnose the install state of the framework's
 * `gan-confine.sh` PreToolUse confinement hook.
 *
 * The command reports two tiers — the user-tier copy authored by the
 * framework's `install.sh` at `~/.claude/hooks/gan-confine.sh`, and an
 * optional project-tier override at `<project>/.claude/hooks/gan-confine.sh`
 * — and for each surfaces the framework-version banner, the derived
 * contract revision (`F1` / `F7` / `unknown`), and the Claude Code
 * registration in `~/.claude/settings.json`. For the project-tier hook
 * only, the command also runs the shared behaviour probe (the load-bearing
 * detector) and resolves the per-tier verdict with probe-wins precedence —
 * the banner is metadata, the probe tests the observable contract.
 *
 * The JSON surface (`--json`) is the v1.0-stable CLI contract documented
 * in the H3 spec; the human surface is the multi-section text form. The
 * exit code is `0` when no project-tier hook is detected or it passes the
 * probe, and `2` when the project-tier hook is `stale` or `misconfigured`
 * so CI can gate on hook hygiene.
 */

import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  compareBanner,
  listBackupSiblings,
  parseConfineHookBanner,
  readInstalledFrameworkVersion,
  runConfineHookProbe,
  type BannerVerdict,
  type ConfineProbeVerdict,
  type ContractRevision,
} from '../../hook-probe/index.js';
import { resolveProjectRoot } from '../lib/project-root.js';
import { emitJson } from '../lib/json-output.js';
import { EXIT_BAD_ARGS, EXIT_OK, EXIT_VALIDATION } from '../lib/exit-codes.js';
import { canonicalizePath } from '../../config-server/determinism/index.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Result contract shared by every CLI command handler.
 *
 * @property stdout text for stdout (rendered output or JSON).
 * @property stderr text for stderr (errors, usage hints).
 * @property code the process exit code.
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Per-tier hook record on the JSON surface for the user tier.
 *
 * @property path the absolute path of the user-tier hook file.
 * @property frameworkVersion the raw semver string the banner declared, or
 *   `null` when the banner is absent or unparseable. The JSON surface emits
 *   `null` only — never the string `"unknown"`.
 * @property contractRevision the derived revision (`'F1'` / `'F7'` /
 *   `'unknown'`); `'unknown'` mirrors the no-banner human label as a
 *   literal JSON string.
 * @property registered whether `~/.claude/settings.json` lists this hook
 *   path under `hooks.PreToolUse[].hooks[].command` via canonical-path
 *   equality. A framework-installed hook is registered by construction;
 *   `false` indicates a manual settings edit removed the entry.
 */
export interface UserTierJsonShape {
  path: string;
  frameworkVersion: string | null;
  contractRevision: ContractRevision;
  registered: boolean;
}

/**
 * Per-tier hook record on the JSON surface for the project tier.
 *
 * @property path the absolute path of the project-tier hook file.
 * @property frameworkVersion same as user tier.
 * @property contractRevision same as user tier.
 * @property bannerVerdict the per-tier comparison against the installed
 *   framework version. `'matches'` / `'lags'` / `'ahead'` fire when both
 *   sides parsed; `'absent'` when the hook carries no banner;
 *   `'unparseable'` when a banner line matched but its semver did not
 *   parse (a hook-side defect the operator can fix); `'installedUnknown'`
 *   when the framework's own `package.json` could not be read (a
 *   framework-side defect distinct from `'unparseable'` so a CI gate can
 *   tell `please fix your hook banner` from `please reinstall the
 *   framework`).
 * @property probeVerdict the behaviour-probe verdict (`'current'` /
 *   `'stale'` / `'misconfigured'`).
 * @property verdict the probe-wins resolution of `bannerVerdict` vs
 *   `probeVerdict`. The probe always wins on disagreement — the banner is
 *   metadata; the probe tests the observable contract.
 * @property backupSiblings absolute paths of every
 *   `gan-confine.sh.gan-bak.<timestamp>` file in the same directory.
 */
export interface ProjectTierJsonShape {
  path: string;
  frameworkVersion: string | null;
  contractRevision: ContractRevision;
  bannerVerdict: BannerVerdict;
  probeVerdict: ConfineProbeVerdict;
  verdict: ConfineProbeVerdict;
  backupSiblings: string[];
}

/**
 * Discriminator value the JSON shape carries so a downstream consumer
 * can branch on the shape version. Incremented on a breaking change
 * (a removed or renamed field, or a tightening of an enum). Additive
 * evolution (a new optional field, a new enum value on a non-gate
 * field) MUST NOT bump it — consumers handle additive evolution by
 * defaulting-allow on unknown enum values for non-gate fields.
 */
export const HOOKS_STATUS_JSON_SCHEMA_VERSION = '1' as const;

/**
 * Top-level JSON shape `gan hooks status --json` emits.
 *
 * @property schemaVersion stable version discriminator the JSON
 *   surface carries; see {@link HOOKS_STATUS_JSON_SCHEMA_VERSION}.
 *   A consumer parsing `gan hooks status --json` SHOULD reject the
 *   payload when this field does not match the version it was
 *   written against. New additive fields do NOT bump the version;
 *   only a removal / rename / enum-tightening does.
 * @property userTier the user-tier record.
 * @property projectTier the project-tier record, or `null` when no file
 *   exists at `<project>/.claude/hooks/gan-confine.sh`.
 * @property verdict the top-level resolution: `projectTier.verdict` when
 *   a project-tier hook is present, otherwise `'current'`. The user tier
 *   does not carry a verdict — `install.sh` refreshes it on every run, so
 *   the framework treats it as authoritative-by-construction. Consumers
 *   gating on this field MUST strictly compare `=== 'current'`; a future
 *   additive verdict literal (e.g. a `'mismatch'` class) MUST NOT
 *   silently fail-open by being treated as "not stale".
 * @property orphanBackupSiblings emitted only when `projectTier` is `null`
 *   but `<project>/.claude/hooks/` still holds one or more
 *   `gan-confine.sh.gan-bak.<timestamp>` files; absent otherwise. This
 *   is the only conditionally-present top-level key on this shape;
 *   every other field is always present so a destructuring consumer
 *   does not need to special-case undefined.
 */
export interface HooksStatusJsonShape {
  schemaVersion: typeof HOOKS_STATUS_JSON_SCHEMA_VERSION;
  userTier: UserTierJsonShape;
  projectTier: ProjectTierJsonShape | null;
  verdict: 'current' | 'stale' | 'misconfigured';
  orphanBackupSiblings?: string[];
}

// `listBackupSiblings` and `readInstalledFrameworkVersion` are
// imported from `src/hook-probe/` so the migrate command, the
// status command, and the MCP wrapper share one definition for
// each — see `src/hook-probe/index.ts` for the rationale.

// Read a hook file's text. Returns `null` when the file is absent or
// unreadable — absence is the common, expected case.
function readHookText(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

// Read the user's `~/.claude/settings.json` and extract every command path
// it registers as a PreToolUse hook. Used to detect Claude Code
// registration via canonical-path equality. Returns an empty list on any
// failure (missing file, malformed JSON, unexpected shape) — registration
// is then reported as `false` rather than the command failing.
function readSettingsHookCommands(settingsPath: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const commands: string[] = [];
  const hooks = (parsed as { hooks?: unknown })?.hooks;
  if (typeof hooks !== 'object' || hooks === null) return commands;
  const preToolUse = (hooks as { PreToolUse?: unknown }).PreToolUse;
  if (!Array.isArray(preToolUse)) return commands;
  for (const entry of preToolUse) {
    if (typeof entry !== 'object' || entry === null) continue;
    const directCommand = (entry as { command?: unknown }).command;
    if (typeof directCommand === 'string' && directCommand.length > 0) {
      commands.push(directCommand);
    }
    const nested = (entry as { hooks?: unknown }).hooks;
    if (Array.isArray(nested)) {
      for (const sub of nested) {
        if (typeof sub !== 'object' || sub === null) continue;
        const cmd = (sub as { command?: unknown }).command;
        if (typeof cmd === 'string' && cmd.length > 0) {
          commands.push(cmd);
        }
      }
    }
  }
  return commands;
}

// True when one of `commands` canonicalises to the same path as `hookPath`.
// Canonical-path equality (not `endsWith`) avoids false positives against
// unrelated entries whose `command` happens to end in the same filename.
function isRegistered(hookPath: string, commands: readonly string[]): boolean {
  let canonicalHook: string;
  try {
    canonicalHook = canonicalizePath(hookPath);
  } catch {
    return false;
  }
  for (const cmd of commands) {
    try {
      if (canonicalizePath(cmd) === canonicalHook) return true;
    } catch {
      // A malformed command path simply does not match; skip it rather
      // than failing the whole registration check.
    }
  }
  return false;
}

// True when `p` exists as a regular file.
function isFileAt(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// Map a contract revision to the human label `gan hooks status` prints
// beside the user-facing "contract revision:" line.
function contractRevisionLabel(rev: ContractRevision): string {
  switch (rev) {
    case 'F1':
      return 'F1 (pre-F7; no GAN_RUN_DIR awareness)';
    case 'F7':
      return 'F7 (knows GAN_RUN_DIR)';
    case 'unknown':
      return 'unknown (no version banner)';
  }
}

// Banner / probe verdict resolution is the identity: the probe wins on
// disagreement in every direction; the banner read is metadata only.
// The helper that used to wrap this assignment was a no-op masquerading
// as resolution logic — every call site now uses the probe verdict
// directly. See the doc-comment on `resolveProbe()` below for the wider
// "probe is the load-bearing detector" rationale.

/**
 * CLI entry point for `gan hooks status`.
 *
 * @param parsed parsed argv; honours `--json` (machine-readable output)
 *   and `--project-root <path>` (resolved via the standard
 *   {@link resolveProjectRoot} helper). Operates on the resolved project
 *   root and on `~/.claude/` for the user-tier hook.
 * @returns a {@link CommandResult}. Exit code is `EXIT_OK` when no
 *   project-tier hook is present or it passes the probe, and
 *   `EXIT_VALIDATION` (`2`) when the project-tier hook is `stale` or
 *   `misconfigured` so a CI gate can refuse the workspace. Failure modes:
 *   the `--project-root` value is missing or not a directory →
 *   {@link resolveProjectRoot} throws, the catch surfaces the structured
 *   error to stderr and exits non-zero.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
  const projectRootFlag = typeof parsed.flags['project-root'] === 'string'
    ? (parsed.flags['project-root'] as string)
    : undefined;

  let projectRootPath: string;
  try {
    projectRootPath = resolveProjectRoot(projectRootFlag).path;
  } catch (e) {
    // `--project-root` resolution failures are argument errors —
    // matches `gan hooks migrate`, `gan trust approve`, and the
    // rest of the CLI. Previously this branch returned
    // EXIT_VALIDATION, which collapsed argument errors onto the
    // same exit class as "the project tree has a stale hook" and
    // left CI gates unable to distinguish the two.
    const msg = e instanceof Error ? e.message : String(e);
    return { stdout: '', stderr: `Error: ${msg}\n`, code: EXIT_BAD_ARGS };
  }

  const home = os.homedir();
  const userHookPath = path.join(home, '.claude', 'hooks', 'gan-confine.sh');
  const userSettingsPath = path.join(home, '.claude', 'settings.json');
  const projectHooksDir = path.join(projectRootPath, '.claude', 'hooks');
  const projectHookPath = path.join(projectHooksDir, 'gan-confine.sh');

  const installedVersion = readInstalledFrameworkVersion();
  const settingsCommands = readSettingsHookCommands(userSettingsPath);

  // User tier: read banner, derive contract revision, check registration.
  const userText = readHookText(userHookPath);
  const userBanner = userText !== null
    ? parseConfineHookBanner(userText)
    : { version: null, contractRevision: 'unknown' as ContractRevision };
  const userRegistered = isFileAt(userHookPath) && isRegistered(userHookPath, settingsCommands);
  const userTier: UserTierJsonShape = {
    path: userHookPath,
    frameworkVersion: userBanner.version,
    contractRevision: userBanner.contractRevision,
    registered: userRegistered,
  };

  // Project tier: only when the file exists. Run the shared probe; the
  // probe is the load-bearing detector — the banner is advisory only.
  const projectExists = isFileAt(projectHookPath);
  const projectBackupSiblings = listBackupSiblings(projectHooksDir);
  let projectTier: ProjectTierJsonShape | null = null;
  let topLevelVerdict: ConfineProbeVerdict = 'current';

  if (projectExists) {
    const projectText = readHookText(projectHookPath);
    const projectBanner = projectText !== null
      ? parseConfineHookBanner(projectText)
      : { version: null, contractRevision: 'unknown' as ContractRevision };
    const bannerVerdict = compareBanner(projectBanner.version, installedVersion);
    const probeResult = await runConfineHookProbe({ hookPath: projectHookPath });
    // The probe wins on disagreement; the banner read is metadata.
    const verdict = probeResult.verdict;
    projectTier = {
      path: projectHookPath,
      frameworkVersion: projectBanner.version,
      contractRevision: projectBanner.contractRevision,
      bannerVerdict,
      probeVerdict: probeResult.verdict,
      verdict,
      backupSiblings: projectBackupSiblings,
    };
    topLevelVerdict = verdict;
  }

  // Orphan-backup case: project-tier file absent but backup siblings still
  // present from a prior `migrate` run. Emit a top-level
  // `orphanBackupSiblings` array on the JSON surface and a single warning
  // line on the human surface.
  const orphanBackupSiblings = !projectExists && projectBackupSiblings.length > 0
    ? projectBackupSiblings
    : undefined;

  const json: HooksStatusJsonShape = {
    schemaVersion: HOOKS_STATUS_JSON_SCHEMA_VERSION,
    userTier,
    projectTier,
    verdict: topLevelVerdict,
  };
  if (orphanBackupSiblings !== undefined) {
    json.orphanBackupSiblings = orphanBackupSiblings;
  }

  // R3 exit-code mapping: stale or misconfigured → 2 (validation failure)
  // so a CI gate can refuse the workspace. Otherwise 0.
  const exitCode = topLevelVerdict === 'current' ? EXIT_OK : EXIT_VALIDATION;

  if (wantJson) {
    return { stdout: emitJson(json) + '\n', stderr: '', code: exitCode };
  }

  const human = renderHuman(
    json,
    userBanner.version,
    installedVersion,
    orphanBackupSiblings,
  );
  return { stdout: human, stderr: '', code: exitCode };
}

/**
 * Render the multi-section human surface for `gan hooks status`.
 *
 * The shape mirrors the verbatim example in the H3 spec § 1: a user-tier
 * block, an optional project-tier block, the orphan-backup warning when
 * applicable, and — on a stale / misconfigured project-tier hook — a
 * remediation hint pointing at `gan hooks migrate`.
 */
function renderHuman(
  json: HooksStatusJsonShape,
  _userVersion: string | null,
  installedVersion: string | null,
  orphanBackupSiblings: readonly string[] | undefined,
): string {
  const lines: string[] = [];
  lines.push(`User-tier hook:    ${json.userTier.path}`);
  lines.push(
    `  framework version:  ${json.userTier.frameworkVersion ?? 'unknown'}` +
      (installedVersion !== null && json.userTier.frameworkVersion === installedVersion
        ? ''
        : installedVersion !== null && json.userTier.frameworkVersion !== null
          ? ` (installed: ${installedVersion})`
          : ''),
  );
  lines.push(`  contract revision:  ${contractRevisionLabel(json.userTier.contractRevision)}`);
  lines.push(
    `  Claude Code reg:    ${json.userTier.registered ? 'registered in ~/.claude/settings.json' : 'not registered'}`,
  );

  if (orphanBackupSiblings !== undefined && orphanBackupSiblings.length > 0) {
    lines.push('');
    lines.push(
      `  Backup siblings present at <project>/.claude/hooks/ from prior migrate operations: ${orphanBackupSiblings.length}. Delete manually if no longer needed.`,
    );
  }

  if (json.projectTier !== null) {
    lines.push('');
    lines.push(`Project-tier hook: ${json.projectTier.path}`);
    lines.push(
      `  framework version:  ${json.projectTier.frameworkVersion ?? 'unknown'}` +
        (json.projectTier.frameworkVersion === null ? ' (no version banner)' : ''),
    );
    lines.push(`  contract revision:  ${contractRevisionLabel(json.projectTier.contractRevision)}`);
    lines.push(`  banner verdict:     ${json.projectTier.bannerVerdict}`);
    lines.push(`  probe verdict:      ${json.projectTier.probeVerdict}`);
    lines.push(`  resolved verdict:   ${json.projectTier.verdict}`);
    lines.push('  Claude Code reg:    overrides user-tier (project takes precedence)');
    if (json.projectTier.backupSiblings.length > 0) {
      lines.push(
        `  backup siblings:    ${json.projectTier.backupSiblings.length} prior migrate operation(s)`,
      );
    }

    if (json.projectTier.verdict === 'stale') {
      lines.push('');
      lines.push('  The project-tier hook lags the framework current contract.');
      lines.push('  A /gan run will fail mid-sprint when an agent tries to write');
      lines.push('  into the central-store run directory.');
      lines.push('');
      lines.push('     If the project-tier hook is a copy of a prior framework hook,');
      lines.push('     delete it (the user-tier framework hook will apply automatically):');
      lines.push('       gan hooks migrate --delete');
      lines.push('');
      lines.push('     If the project-tier hook is a deliberate override, run');
      lines.push('     `gan hooks migrate --review` to see the diff against the');
      lines.push('     framework current template, and update by hand.');
    } else if (json.projectTier.verdict === 'misconfigured') {
      lines.push('');
      lines.push('  The project-tier hook is not a runnable bash script');
      lines.push('  (no valid shebang, not executable, or the spawn errored).');
      lines.push('  Fix or remove the file before running /gan:');
      lines.push('     gan hooks migrate --delete       # remove (with backup)');
      lines.push('     gan hooks migrate --replace      # replace with the framework template');
    }
  }

  return lines.join('\n') + '\n';
}
