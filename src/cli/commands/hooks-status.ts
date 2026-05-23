

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

export interface UserTierStatus {

  path: string;

  present: boolean;

  authoredVersion: string | null;

  current: boolean;
}

export interface ProjectTierStatus {

  path: string;

  present: boolean;

  legacy: boolean;
}

export interface RunZonesStatus {

  runId: string | null;

  worktree: string | null;

  runDir: string | null;
}

export interface HooksStatusOutput {

  frameworkVersion: string;
  userTier: UserTierStatus;
  projectTier: ProjectTierStatus;

  runZones: RunZonesStatus;

  projectTierTakesPrecedence: boolean;

  legacyDeletionHint: boolean;
}

function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..', '..');
}

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

async function readHookText(hookPath: string): Promise<string | null> {
  try {
    return await readFile(hookPath, 'utf8');
  } catch {
    return null;
  }
}

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

export function isLegacyProjectHook(content: string): boolean {
  const referencesCurrentZone = content.includes('.gan-state/');
  if (referencesCurrentZone) return false;

  const referencesLegacyZone = content.includes('.gan/');
  return referencesLegacyZone;
}

function displayUserPath(absPath: string, home: string): string {
  if (home && (absPath === home || absPath.startsWith(home + path.sep))) {
    return '~' + absPath.slice(home.length);
  }
  return absPath;
}

function readEnvOrNull(env: NodeJS.ProcessEnv, key: string): string | null {
  const v = env[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

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

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
  const cwd = process.cwd();
  const home = os.homedir();

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
