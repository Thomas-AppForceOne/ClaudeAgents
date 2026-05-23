/**
 * Structured JSON logger for the config-server.
 *
 * Two shared guarantees hold for every entry, stated once here:
 * 1. Secrets never reach a log. Metadata is run through {@link sanitiseMeta},
 *    which drops a fixed denylist of sensitive keys (config values, overlay
 *    contents, trust hashes) before the entry is written.
 * 2. Inside a `/gan` run the log goes to a per-run *file*, never stderr —
 *    stderr output during a run pollutes the MCP stdio channel and test
 *    output. Outside a run (no `runId`) there is no file to write, so stderr
 *    is the deliberate fallback.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { stableStringify } from '../determinism/index.js';

/** Severity of a log entry; ordered informally info < warn < error. */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * Configuration for {@link getLogger}. All fields optional; the production
 * default `{}` derives everything from the process (cwd + `GAN_RUN_ID`).
 *
 * @property projectRoot base directory under which the per-run log file lives;
 *   defaults to `process.cwd()`.
 * @property runId the `/gan` run identifier that selects the file sink;
 *   defaults to the `GAN_RUN_ID` env var. Absent ⇒ stderr sink.
 * @property forceStderr when `true`, always log to stderr even if a `runId`
 *   is present — used by tests/tooling that want to observe output directly.
 */
export interface LoggerOptions {

  projectRoot?: string;

  runId?: string;

  forceStderr?: boolean;
}

/**
 * The serialised shape of one log line. `level`/`msg`/`ts` are always present;
 * `ts` is an ISO-8601 timestamp. Sanitised metadata is spread in as additional
 * fields via the index signature.
 */
export interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  [field: string]: unknown;
}

/**
 * The logger handle returned by {@link getLogger}. Each level method writes one
 * sanitised entry; `meta` is optional structured context (sensitive keys are
 * stripped before writing).
 *
 * @property sink reports where entries go — the absolute log file path, or the
 *   literal `'stderr'`. Useful for diagnostics and tests.
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;

  sink(): string;
}

// Metadata keys that may carry user config values or trust secrets. They are
// dropped wholesale before any write — the security guarantee in the module
// header. Callers may safely pass these keys; they simply will not be logged.
const FORBIDDEN_META_KEYS = new Set(['value', 'overlay', 'overlayContents', 'trustHash', 'hash']);

// Return a shallow copy of `meta` with every FORBIDDEN_META_KEYS entry omitted.
// Centralised so the denylist is applied uniformly to all log levels.
function sanitiseMeta(meta?: Record<string, unknown>): Record<string, unknown> {
  if (!meta) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(meta)) {
    if (FORBIDDEN_META_KEYS.has(k)) continue;
    out[k] = meta[k];
  }
  return out;
}

/**
 * Build a {@link Logger} bound to a sink chosen from `opts`.
 *
 * Sink selection (see module header): a file under
 * `<projectRoot>/.gan-state/runs/<runId>/logs/config-server.log` when a
 * non-empty `runId` is available and `forceStderr` is not set; otherwise
 * `process.stderr`.
 *
 * @param opts see {@link LoggerOptions}; defaults derive from cwd + env.
 * @returns a logger whose level methods are side-effecting (each writes one
 *   line). Writes are best-effort: if creating/appending the file fails, the
 *   entry falls back to stderr rather than throwing — logging must never break
 *   the operation it is observing.
 */
export function getLogger(opts: LoggerOptions = {}): Logger {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const runId = opts.runId ?? process.env.GAN_RUN_ID;
  const forceStderr = opts.forceStderr === true;

  const useFile = !forceStderr && typeof runId === 'string' && runId.length > 0;
  const filePath = useFile
    ? path.join(projectRoot, '.gan-state', 'runs', runId, 'logs', 'config-server.log')
    : null;

  const write = (entry: LogEntry): void => {
    const line = stableStringify(entry);
    if (filePath) {
      try {
        mkdirSync(path.dirname(filePath), { recursive: true });
        appendFileSync(filePath, line, { encoding: 'utf8' });
      } catch {
        // File sink failed (permissions, missing dir we could not create):
        // fall back to stderr so the entry is not silently lost.
        process.stderr.write(line);
      }
    } else {
      process.stderr.write(line);
    }
  };

  const log = (level: LogLevel, msg: string, meta?: Record<string, unknown>): void => {
    const entry: LogEntry = {
      level,
      msg,
      ts: new Date().toISOString(),
      ...sanitiseMeta(meta),
    };
    write(entry);
  };

  return {
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    sink: () => filePath ?? 'stderr',
  };
}
