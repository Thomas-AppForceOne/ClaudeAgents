/**
 * Drives the real `install.sh` as a child process for the installer suites.
 *
 * Every installer test ultimately runs the actual shipped `install.sh` under
 * bash with a hermetic environment — a fake `$HOME`, a `PATH` rigged to the
 * test's stub binaries, and captured stdout/stderr — and asserts on the exit
 * code and output. This module is the single seam that spawns it, so the
 * env-construction rules (HOME/PATH precedence, extra vars) live in one place
 * and the suites stay declarative.
 *
 * `bash` is located up front via {@link resolveBash} so a system without
 * `/bin/bash` still works as long as some `bash` is on `PATH`; the path to the
 * script and the repo root are derived from this module's own URL so tests do
 * not hard-code absolute paths.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const installScript = path.join(repoRoot, 'install.sh');

// Locate a usable bash: prefer the canonical /bin/bash, otherwise walk PATH.
// Resolved once at module load and cached in `bashPath` below.
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

/**
 * Environment knobs for a single {@link runInstall} invocation. All optional;
 * an empty `{}` runs the installer against the current process's HOME/PATH in
 * the repo root.
 *
 * @property home value for the child's `HOME`; falls back to the parent
 *   process's `HOME` when omitted. Tests almost always pass a fake home.
 * @property prependPath directories prepended to the inherited `PATH` (so stub
 *   binaries shadow the real ones). Mutually exclusive in effect with
 *   `pathOverride` — `pathOverride` wins if both are given.
 * @property pathOverride a complete replacement `PATH`, ignoring the inherited
 *   one entirely (used when a test wants a fully sealed PATH of only stubs).
 * @property cwd working directory to run the installer from; defaults to the
 *   repo root. Often a fake project repo so cwd-relative behaviour is exercised.
 * @property extraEnv additional environment variables merged in last (so they
 *   can carry `CAS_FAIL_*` failure flags from {@link FailurePointEnv}).
 * @property timeoutMs hard kill timeout; defaults to 15s. On expiry the child
 *   is SIGKILLed and the returned promise rejects.
 */
export interface RunInstallOptions {

  home?: string;

  prependPath?: readonly string[];

  pathOverride?: string;

  cwd?: string;

  extraEnv?: Readonly<Record<string, string>>;

  timeoutMs?: number;
}

/**
 * Captured outcome of an installer run.
 *
 * @property exitCode the process exit code (or `128` if killed by a signal,
 *   `-1` if neither code nor signal was reported).
 * @property stdout the full UTF-8 stdout.
 * @property stderr the full UTF-8 stderr.
 */
export interface RunInstallResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The repository root, derived from this module's location. Tests use it to
 * read `package.json`, the agents/skills sources, and other repo fixtures.
 */
export function repoRootDir(): string {
  return repoRoot;
}

/**
 * Absolute path to the `install.sh` under test (the shipped installer at the
 * repo root). Used by static-analysis tests that read the script's source.
 */
export function installScriptPath(): string {
  return installScript;
}

/**
 * Run `install.sh` with the given args and environment, resolving with its
 * captured exit code and output.
 *
 * Constructs the child env deterministically: `HOME` from `options.home` (or
 * inherited), `PATH` from `pathOverride` if set else `prependPath` joined ahead
 * of the inherited PATH, then `extraEnv` merged on top. stdin is closed; stdout
 * and stderr are fully buffered.
 *
 * @param args argument vector passed to the installer (e.g. `['--uninstall']`);
 *   defaults to none.
 * @param options environment + timeout overrides; see {@link RunInstallOptions}.
 * @returns a promise of the {@link RunInstallResult}.
 * @throws (promise rejection) if the process cannot be spawned, or if it does
 *   not exit within `timeoutMs` (it is SIGKILLed first).
 */
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

  // Race the child's exit against a watchdog timer: a hung installer would
  // otherwise stall the whole suite, so on timeout we hard-kill and reject
  // rather than wait indefinitely. The timer is cleared on exit/error below.
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
