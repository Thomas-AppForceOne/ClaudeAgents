/**
 * Test harness for R4 maintainer scripts.
 *
 * Spawns the built `dist/scripts/<name>/index.js` via the host Node so
 * each test runs the same compiled artefact that ships in CI. We pass
 * `--no-warnings` to keep the success-path stderr empty (the script
 * imports schemas-bundled.ts which loads JSON via `import attributes`
 * and emits an `ExperimentalWarning`).
 *
 * Mirrors the shape of `tests/cli/helpers/spawn.ts` and
 * `tests/installer/helpers/spawn.ts` so reviewers see one pattern.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

export interface RunScriptOptions {
  /** Working directory; defaults to the repo root. */
  cwd?: string;
  /** Additional env vars merged onto the inherited environment. */
  extraEnv?: Readonly<Record<string, string>>;
  /** Override PATH wholesale. */
  pathOverride?: string;
  /** Timeout in ms; defaults to 15s. */
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

/**
 * Spawn a built maintainer script under `dist/scripts/<scriptName>/`.
 */
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
  // Forward the test-isolation override so spawned scripts honour the
  // same built-in package tier as in-process tests do (see tests/setup.ts).
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
