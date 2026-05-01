/**
 * R2 sprint 1 — `install.sh` test harness.
 *
 * Shells out to `install.sh` via `child_process.spawn` under controlled env.
 * Bash itself is resolved once at module load against the host PATH so a
 * test that supplies a stub-only PATH still has an interpreter to launch
 * `install.sh` with — the PATH override only applies to processes the
 * spawned `install.sh` itself starts (e.g. `node`, `git`, `claude`).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const installScript = path.join(repoRoot, 'install.sh');

function resolveBash(): string {
  if (existsSync('/bin/bash')) {
    return '/bin/bash';
  }
  const fromEnv = process.env.PATH ?? '';
  for (const dir of fromEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bash');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error('Could not locate bash on this system');
}

const bashPath = resolveBash();

export interface RunInstallOptions {
  /** Extra HOME to expose to `install.sh` (overrides the inherited HOME). */
  home?: string;
  /**
   * Directories to prepend to PATH (in order; first is searched first).
   * If `pathOverride` is supplied, it wins; otherwise these are prepended
   * to the inherited PATH.
   */
  prependPath?: readonly string[];
  /**
   * Replace PATH wholesale (no inheritance from process.env.PATH). Use this
   * when a test needs `install.sh` to see ONLY the supplied stubs.
   */
  pathOverride?: string;
  /** Working directory; defaults to the repo root. */
  cwd?: string;
  /** Additional environment variables. */
  extraEnv?: Readonly<Record<string, string>>;
  /** Timeout in milliseconds; defaults to 15s. */
  timeoutMs?: number;
}

export interface RunInstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function repoRootDir(): string {
  return repoRoot;
}

export function installScriptPath(): string {
  return installScript;
}

export async function runInstall(
  args: readonly string[] = [],
  options: RunInstallOptions = {},
): Promise<RunInstallResult> {
  const cwd = options.cwd ?? repoRoot;

  const env: Record<string, string> = {};
  if (options.home !== undefined) {
    env.HOME = options.home;
  } else if (process.env.HOME !== undefined) {
    env.HOME = process.env.HOME;
  }

  let pathValue: string;
  if (options.pathOverride !== undefined) {
    pathValue = options.pathOverride;
  } else {
    const inherited = process.env.PATH ?? '';
    const prepended = options.prependPath ?? [];
    pathValue = [...prepended, ...(inherited ? [inherited] : [])].join(path.delimiter);
  }
  env.PATH = pathValue;

  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      env[k] = v;
    }
  }

  const child = spawn(bashPath, [installScript, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const timeoutMs = options.timeoutMs ?? 15_000;

  return await new Promise<RunInstallResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runInstall: timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const exitCode = code ?? (signal ? 128 : -1);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
