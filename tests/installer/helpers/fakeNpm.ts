
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { writeStubBin } from './tmpenv.js';

export interface FakeNpmOptions {

  exitCode?: number;

  stderr?: string;

  invocationLog: string;
}

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

export interface FakeConfigServerOptions {

  version: string;

  defaultExitCode?: number;
}

export function writeFakeConfigServer(bin: string, options: FakeConfigServerOptions): string {
  const exitCode = options.defaultExitCode ?? 0;
  const v = JSON.stringify(options.version);
  const body = `if [ "$1" = "--version" ]; then\n  printf '%s\\n' ${v}\n  exit 0\nfi\nexit ${exitCode}\n`;
  return writeStubBin(bin, 'claudeagents-config-server', body);
}

export function readNpmInvocations(invocationLog: string): string[] {
  if (!existsSync(invocationLog)) return [];
  const raw = readFileSync(invocationLog, 'utf8');
  if (!raw) return [];
  return raw.split('\n').filter((line) => line.length > 0);
}

export function npmInvocationLog(tmpRoot: string): string {
  return path.join(tmpRoot, 'npm-invocations.log');
}
