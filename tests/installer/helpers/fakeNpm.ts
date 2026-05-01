/**
 * R2 sprint 2 — `npm` and `claudeagents-config-server` stubs for installer
 * tests.
 *
 * `writeFakeNpm()` writes a stub `npm` into `bin/` that records every
 * invocation (one line per call: argv joined by spaces) into a sentinel
 * file the test reads via `readNpmInvocations()`. Configurable to
 * succeed silently, fail with a chosen exit code, or echo a stderr
 * line.
 *
 * `writeFakeConfigServer()` writes a stub `claudeagents-config-server`
 * that responds to `--version` with a configurable string. Other argv
 * forms (e.g. `--validate-all`) succeed silently by default.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writeStubBin } from './tmpenv.js';

export interface FakeNpmOptions {
  /** Exit code to return; default 0. */
  exitCode?: number;
  /** Optional stderr line to emit before exiting. */
  stderr?: string;
  /** Path to a sentinel file the stub appends every invocation to. */
  invocationLog: string;
}

/**
 * Writes a stub `npm` into `bin/`. Records each invocation to
 * `options.invocationLog` (one line per call, argv joined by single
 * spaces).
 */
export function writeFakeNpm(bin: string, options: FakeNpmOptions): string {
  const exitCode = options.exitCode ?? 0;
  const stderrLine = options.stderr ?? '';
  const escapedLog = JSON.stringify(options.invocationLog);
  const escapedStderr = JSON.stringify(stderrLine);

  // The body appends `$*` (joined argv) plus a newline to the log file
  // every call, then optionally prints a stderr line, then exits.
  const body = `printf '%s\\n' "$*" >> ${escapedLog}\nif [ -n ${escapedStderr} ]; then\n  printf '%s\\n' ${escapedStderr} >&2\nfi\nexit ${exitCode}\n`;
  return writeStubBin(bin, 'npm', body);
}

export interface FakeConfigServerOptions {
  /** Version string to print for `--version` (no leading `v`). */
  version: string;
  /**
   * Exit code for non-`--version` invocations (e.g. `--validate-all`);
   * default 0.
   */
  defaultExitCode?: number;
}

/**
 * Writes a stub `claudeagents-config-server` into `bin/`. Responds to
 * `--version` with the configured version string. Any other argv form
 * exits with `defaultExitCode` (0 by default).
 */
export function writeFakeConfigServer(bin: string, options: FakeConfigServerOptions): string {
  const exitCode = options.defaultExitCode ?? 0;
  const v = JSON.stringify(options.version);
  const body = `if [ "$1" = "--version" ]; then\n  printf '%s\\n' ${v}\n  exit 0\nfi\nexit ${exitCode}\n`;
  return writeStubBin(bin, 'claudeagents-config-server', body);
}

/**
 * Reads the sentinel file populated by `writeFakeNpm()` and returns the
 * recorded invocations as an array (one entry per call, in order). Each
 * entry is the argv string the stub received.
 */
export function readNpmInvocations(invocationLog: string): string[] {
  if (!existsSync(invocationLog)) return [];
  const raw = readFileSync(invocationLog, 'utf8');
  if (!raw) return [];
  return raw.split('\n').filter((line) => line.length > 0);
}

/** Convenience: builds a sentinel-file path inside the tmp root. */
export function npmInvocationLog(tmpRoot: string): string {
  return path.join(tmpRoot, 'npm-invocations.log');
}
