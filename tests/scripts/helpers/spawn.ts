
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

export interface RunScriptOptions {

  cwd?: string;

  extraEnv?: Readonly<Record<string, string>>;

  pathOverride?: string;

  timeoutMs?: number;
}

export interface RunScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function repoRootDir(): string {
  return repoRoot;
}

export async function runScript(
  scriptName: string,
  args: readonly string[] = [],
  options: RunScriptOptions = {},
): Promise<RunScriptResult> {
  const entry = path.join(repoRoot, 'dist', 'scripts', scriptName, 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`runScript: ${entry} does not exist. Run \`npm run build\` before tests.`);
  }
  const cwd = options.cwd ?? repoRoot;

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
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const timeoutMs = options.timeoutMs ?? 15_000;
  return await new Promise<RunScriptResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`runScript: timeout after ${timeoutMs}ms`));
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
