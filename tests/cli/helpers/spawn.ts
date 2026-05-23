
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');

export interface RunGanOptions {

  cwd?: string;

  extraEnv?: Readonly<Record<string, string>>;

  pathOverride?: string;

  timeoutMs?: number;

  entryOverride?: string;
}

export interface RunGanResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function repoRootDir(): string {
  return repoRoot;
}

export function cliEntryPath(): string {
  return cliEntry;
}

export async function runGan(
  args: readonly string[] = [],
  options: RunGanOptions = {},
): Promise<RunGanResult> {
  const cwd = options.cwd ?? repoRoot;
  const entry = options.entryOverride ?? cliEntry;

  if (!options.entryOverride && !existsSync(entry)) {
    throw new Error(`runGan: ${entry} does not exist. Run \`npm run build\` before tests.`);
  }

  const env: Record<string, string> = {};

  if (options.pathOverride !== undefined) {
    env.PATH = options.pathOverride;
  } else if (process.env.PATH !== undefined) {
    env.PATH = process.env.PATH;
  }
  if (process.env.HOME !== undefined) {
    env.HOME = process.env.HOME;
  }

  if (process.env.GAN_PACKAGE_ROOT_OVERRIDE !== undefined) {
    env.GAN_PACKAGE_ROOT_OVERRIDE = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  }
  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      env[k] = v;
    }
  }

  const child = spawn(process.execPath, ['--no-warnings', entry, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const timeoutMs = options.timeoutMs ?? 15_000;
  return await new Promise<RunGanResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runGan: timeout after ${timeoutMs}ms`));
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
