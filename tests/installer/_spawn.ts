/**
 * R2 sprint 1 test harness — shells out to install.sh under controlled env.
 *
 * Spawns bash via an absolute path (resolved once at module load) so a test
 * that supplies a stub-only PATH does not also lose access to `bash` itself.
 * The PATH override applies to the spawned `install.sh` and its children, not
 * to the bash interpreter used to launch it.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
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

export interface SpawnInstallerOptions {
  args?: readonly string[];
  cwd?: string;
  homeOverride?: string;
  pathOverride?: string;
  extraEnv?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

export interface SpawnInstallerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export function repoRootDir(): string {
  return repoRoot;
}

export function installScriptPath(): string {
  return installScript;
}

export function bashInterpreter(): string {
  return bashPath;
}

export function spawnInstaller(
  options: SpawnInstallerOptions = {},
): Promise<SpawnInstallerResult> {
  const args = [installScript, ...(options.args ?? [])];
  const cwd = options.cwd ?? repoRoot;

  const env: Record<string, string> = {};
  if (options.homeOverride !== undefined) {
    env.HOME = options.homeOverride;
  } else if (process.env.HOME !== undefined) {
    env.HOME = process.env.HOME;
  }
  env.PATH = options.pathOverride ?? process.env.PATH ?? '';
  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      env[k] = v;
    }
  }

  const child = spawn(bashPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const timeoutMs = options.timeoutMs ?? 15_000;
  let timer: NodeJS.Timeout | null = null;

  return new Promise<SpawnInstallerResult>((resolve, reject) => {
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`spawnInstaller: timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
