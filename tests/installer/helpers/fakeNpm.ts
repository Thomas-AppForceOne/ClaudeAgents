/**
 * Fake `npm` and `claudeagents-config-server` binaries for the installer
 * suites, plus helpers to read back what the installer invoked.
 *
 * Real `npm install -g` and a real config-server are slow, networked, and
 * machine-mutating — unacceptable in a hermetic test. These stubs stand in:
 * the fake `npm` records every invocation to a log file (so a test can assert
 * *what* the installer called, e.g. that a second run did not re-install) and
 * can be told to fail the `install` subcommand on demand; the fake
 * config-server answers `--version` with a caller-chosen string so the
 * installer's version-probe / reinstall logic can be driven both ways.
 *
 * The shell bodies passed to {@link writeStubBin} are DATA: `$1`, `$*`,
 * `printf`, etc. are interpolated test fixtures, not this module's own code.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writeStubBin } from './tmpenv.js';

/**
 * Behaviour knobs for the fake `npm` written by {@link writeFakeNpm}.
 *
 * @property exitCode exit status the stub returns for a normal invocation;
 *   defaults to `0`. (The `install` subcommand can still be forced to fail
 *   independently via the `CAS_FAIL_NPM_INSTALL` env flag.)
 * @property stderr a line emitted to stderr on every invocation; defaults to
 *   empty (nothing written). Lets a test simulate npm's own error chatter.
 * @property invocationLog absolute path the stub appends each invocation's
 *   argument string to; required, and the same path is later read by
 *   {@link readNpmInvocations}.
 */
export interface FakeNpmOptions {

  exitCode?: number;

  stderr?: string;

  invocationLog: string;
}

/**
 * Write a fake `npm` executable into `bin`.
 *
 * The stub appends its arguments to the invocation log on every call, may
 * print a fixed stderr line, fails the `install` subcommand when
 * `CAS_FAIL_NPM_INSTALL=1` (the rollback suites' npm-failure seam), and
 * otherwise exits with `options.exitCode`. All option values are JSON-escaped
 * before embedding so paths containing quotes or spaces stay intact.
 *
 * @param bin the stub-binary directory to install `npm` into.
 * @param options see {@link FakeNpmOptions}.
 * @returns the absolute path of the written stub.
 */
export function writeFakeNpm(bin: string, options: FakeNpmOptions): string {
  const exitCode = options.exitCode ?? 0;
  const stderrLine = options.stderr ?? '';
  const escapedLog = JSON.stringify(options.invocationLog);
  const escapedStderr = JSON.stringify(stderrLine);

  const body = [
    `printf '%s\\n' "$*" >> ${escapedLog}`,
    `if [ -n ${escapedStderr} ]; then`,
    `  printf '%s\\n' ${escapedStderr} >&2`,
    `fi`,
    `if [ "\${CAS_FAIL_NPM_INSTALL:-0}" = "1" ] && [ "$1" = "install" ]; then`,
    `  printf '%s\\n' "npm ERR! injected failure" >&2`,
    `  exit 1`,
    `fi`,
    `exit ${exitCode}`,
  ].join('\n');
  return writeStubBin(bin, 'npm', body);
}

/**
 * Behaviour knobs for the fake `claudeagents-config-server` written by
 * {@link writeFakeConfigServer}.
 *
 * @property version the string the stub prints for `--version`. Setting this
 *   equal to / different from `package.json`'s version is how the suites drive
 *   the installer's "already current" vs "version mismatch → reinstall" paths.
 * @property defaultExitCode exit status for any non-`--version` invocation;
 *   defaults to `0`.
 */
export interface FakeConfigServerOptions {

  version: string;

  defaultExitCode?: number;
}

/**
 * Write a fake `claudeagents-config-server` executable into `bin`.
 *
 * The stub prints `options.version` and exits 0 for `--version`; any other
 * invocation exits with `options.defaultExitCode`. The version is JSON-escaped
 * before embedding.
 *
 * @param bin the stub-binary directory to install the server into.
 * @param options see {@link FakeConfigServerOptions}.
 * @returns the absolute path of the written stub.
 */
export function writeFakeConfigServer(bin: string, options: FakeConfigServerOptions): string {
  const exitCode = options.defaultExitCode ?? 0;
  const v = JSON.stringify(options.version);
  const body = `if [ "$1" = "--version" ]; then\n  printf '%s\\n' ${v}\n  exit 0\nfi\nexit ${exitCode}\n`;
  return writeStubBin(bin, 'claudeagents-config-server', body);
}

/**
 * Read back the fake npm's recorded invocations, one per line.
 *
 * @param invocationLog the log path given to {@link writeFakeNpm}.
 * @returns each invocation's argument string in call order; an empty array
 *   when the log is absent or empty (npm was never invoked). Blank lines are
 *   filtered out so callers can compare against `[]` to assert "no calls".
 */
export function readNpmInvocations(invocationLog: string): string[] {
  if (!existsSync(invocationLog)) return [];
  const raw = readFileSync(invocationLog, 'utf8');
  if (!raw) return [];
  return raw.split('\n').filter((line) => line.length > 0);
}

/**
 * The conventional invocation-log path for a given temp root, so the stub
 * writer and the reader agree on one location without threading it manually.
 *
 * @param tmpRoot the per-test temp root.
 * @returns `<tmpRoot>/npm-invocations.log`.
 */
export function npmInvocationLog(tmpRoot: string): string {
  return path.join(tmpRoot, 'npm-invocations.log');
}
