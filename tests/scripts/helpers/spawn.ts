/**
 * Test helper for driving the repo's built CLI scripts as real child
 * processes. The bin tests (lint-stacks, lint-no-stack-leak, lint-error-text,
 * pair-names, publish-schemas, evaluator-pipeline-check) assert on a script's
 * actual exit code, stdout, and stderr; doing that faithfully means spawning
 * the compiled `dist/scripts/<name>/index.js` entrypoint rather than calling
 * library functions in-process. This module centralises that spawn so each
 * suite shares one hermetic, env-controlled, timeout-guarded runner.
 *
 * The exported surface is deliberately small: a path accessor for locating
 * fixtures relative to the repo, and the `runScript` driver itself.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root from this file's own location (tests/scripts/helpers),
// three levels up — so the helper works regardless of the caller's cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * Options for {@link runScript}. All fields are optional; the defaults run the
 * script from the repo root with the parent process's `PATH`/`HOME` and a
 * 15-second timeout.
 *
 * @property cwd working directory for the child; defaults to the repo root.
 * @property extraEnv extra environment variables merged in last, so they win
 *   over the inherited `PATH`/`HOME`/package-root entries.
 * @property pathOverride replacement value for the child's `PATH`; when set it
 *   is used instead of inheriting the parent `PATH` (lets a test prove a
 *   script behaves when a tool is absent from `PATH`).
 * @property timeoutMs hard wall-clock cap; the child is SIGKILLed and the
 *   promise rejects if it overruns. Defaults to 15000.
 */
export interface RunScriptOptions {
  cwd?: string;

  extraEnv?: Readonly<Record<string, string>>;

  pathOverride?: string;

  timeoutMs?: number;
}

/**
 * The captured outcome of a finished child process.
 *
 * @property exitCode the process exit code; a signal-terminated child is
 *   reported as 128 and an otherwise-unknown end as -1.
 * @property stdout full stdout, decoded as UTF-8.
 * @property stderr full stderr, decoded as UTF-8.
 */
export interface RunScriptResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Absolute path to the repository root, as resolved from this helper's
 * location. Suites use it to build paths to fixtures, schemas, and goldens.
 */
export function repoRootDir(): string {
  return repoRoot;
}

/**
 * Spawn a built CLI script as a child process and resolve with its captured
 * exit code, stdout, and stderr.
 *
 * The script is run from its compiled entrypoint under `dist/`, so a missing
 * build is reported as a clear error pointing at `npm run build` rather than a
 * confusing spawn failure. The child environment is constructed from scratch
 * (not the full parent env) so tests stay hermetic: only `PATH`, `HOME`, the
 * package-root override, and any caller `extraEnv` are forwarded. The run is
 * bounded by a timeout that SIGKILLs and rejects on overrun.
 *
 * @param scriptName the script directory under `dist/scripts/` to execute.
 * @param args argv passed after the entrypoint.
 * @param options see {@link RunScriptOptions}.
 * @returns the child's {@link RunScriptResult}.
 * @throws if the built entrypoint is missing or the run exceeds the timeout.
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

  // Build the child env from scratch rather than spreading process.env, so a
  // test only sees the variables it explicitly opts into. pathOverride wins
  // over the inherited PATH; extraEnv (applied last) wins over everything.
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

  // Run under the same node binary as the test process; --no-warnings keeps
  // stderr assertions clean of unrelated node deprecation noise.
  const child = spawn(process.execPath, ['--no-warnings', entry, ...args], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Buffer raw chunks and decode once at the end, so multi-byte UTF-8 split
  // across reads is never mangled.
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const timeoutMs = options.timeoutMs ?? 15_000;
  return await new Promise<RunScriptResult>((resolve, reject) => {
    // A hung script must not hang the whole suite: SIGKILL on overrun and
    // reject so the test fails fast with a clear timeout message.
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
      // A normal exit carries a numeric code; a signal kill leaves code null,
      // which we map to 128 (signal) or -1 (neither code nor signal known).
      const exitCode = code ?? (signal ? 128 : -1);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
