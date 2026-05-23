
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

  home?: string;

  prependPath?: readonly string[];

  pathOverride?: string;

  cwd?: string;

  extraEnv?: Readonly<Record<string, string>>;

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
