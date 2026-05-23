/**
 * Test harness for driving the built `gan` CLI as a real child process.
 *
 * The CLI tests are black-box end-to-end tests: rather than import the CLI's
 * internals, they spawn the compiled entrypoint (`dist/cli/index.js`) exactly
 * as a user would, so the suite exercises argv parsing, exit codes, and
 * stdout/stderr framing the way the shipped binary actually behaves. This
 * helper centralises that spawn so every test gets the same hermetic,
 * controlled environment.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the repo root relative to this compiled file (dist/.../helpers), then
// the CLI entry the tests spawn. Tests require a prior `npm run build`.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');

/**
 * Per-invocation overrides for {@link runGan}.
 *
 * @property cwd working directory for the spawned CLI; defaults to the repo
 *   root. Tests point this at a temp project to drive cwd-relative behaviour.
 * @property extraEnv environment entries layered on top of the curated base
 *   env (see {@link runGan}); last-writer-wins, so a key here overrides the
 *   forwarded `HOME`/`PATH`.
 * @property pathOverride replaces `PATH` entirely for the child — used to
 *   simulate a stripped/empty `PATH` without disturbing the parent process.
 * @property timeoutMs hard kill deadline; the child is SIGKILLed and the
 *   promise rejects if it has not exited by then (default 15s).
 * @property entryOverride spawn this entrypoint instead of the real CLI; used
 *   by the "unreachable framework library" tests to point at a broken dist.
 */
export interface RunGanOptions {

  cwd?: string;

  extraEnv?: Readonly<Record<string, string>>;

  pathOverride?: string;

  timeoutMs?: number;

  entryOverride?: string;
}

/** Captured outcome of a single CLI invocation: exit status plus both streams. */
export interface RunGanResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Absolute path to the repository root, derived from this file's location. */
export function repoRootDir(): string {
  return repoRoot;
}

/** Absolute path to the built CLI entrypoint the tests spawn. */
export function cliEntryPath(): string {
  return cliEntry;
}

/**
 * Spawn the built `gan` CLI with `args` and collect its exit code and output.
 *
 * The child runs with a deliberately minimal, curated environment rather than
 * inheriting the parent's: only `PATH`, `HOME`, and `GAN_PACKAGE_ROOT_OVERRIDE`
 * are forwarded (when set), plus anything in `options.extraEnv`. This keeps the
 * spawned CLI hermetic — ambient env vars on the developer/CI machine cannot
 * leak in and perturb resolution or output.
 *
 * @param args argv passed to the CLI (the subcommand and its flags).
 * @param options see {@link RunGanOptions}.
 * @returns the child's exit code and captured stdout/stderr (UTF-8).
 * @throws if the real CLI entry is missing (build not run), or — via the
 *   returned promise's rejection — on spawn error or timeout.
 */
export async function runGan(
  args: readonly string[] = [],
  options: RunGanOptions = {},
): Promise<RunGanResult> {
  const cwd = options.cwd ?? repoRoot;
  const entry = options.entryOverride ?? cliEntry;

  // Only guard the real entry: an entryOverride may legitimately point at a
  // fixture path constructed by the test, so its existence is the test's
  // concern, not this helper's.
  if (!options.entryOverride && !existsSync(entry)) {
    throw new Error(`runGan: ${entry} does not exist. Run \`npm run build\` before tests.`);
  }

  // Build the child env from scratch (not `...process.env`) so only the
  // explicitly-forwarded keys reach the CLI.
  const env: Record<string, string> = {};

  // pathOverride wins outright (e.g. simulate an empty PATH); otherwise forward
  // the parent PATH so the child can still find `node`/`git` when it needs them.
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
  // Layered last so a test's extraEnv can override any forwarded key (notably
  // HOME, which several suites repoint at a temp dir to isolate the trust cache).
  if (options.extraEnv) {
    for (const [k, v] of Object.entries(options.extraEnv)) {
      env[k] = v;
    }
  }

  // `--no-warnings` keeps Node deprecation/experimental warnings off stderr, so
  // tests that assert `stderr === ''` are not flaked by the runtime.
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
    // SIGKILL (not SIGTERM) so a wedged child cannot ignore the signal and
    // hang the suite past its deadline.
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
      // Normalise the exit status: a real numeric code wins; a signal-only exit
      // is reported as 128 (conventional "killed by signal"); the all-null case
      // (neither) collapses to -1 so callers always get a number.
      const exitCode = code ?? (signal ? 128 : -1);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}
