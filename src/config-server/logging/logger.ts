/**
 * Per-run log routing for the config server.
 *
 * R1-locked rule: when `GAN_RUN_ID` is set, routes to
 * `<projectRoot>/.gan-state/runs/<id>/logs/config-server.log`. Otherwise logs
 * to stderr. Lines are JSON via `stableStringify` (sorted keys, trailing
 * newline). Anonymisation: the logger never accepts `value` payloads,
 * overlay contents, or trust hashes — only names, paths, and result codes.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { stableStringify } from '../determinism/index.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LoggerOptions {
  /** Project root used to anchor the per-run log path. Defaults to `cwd`. */
  projectRoot?: string;
  /** Override `GAN_RUN_ID` for testing. */
  runId?: string;
  /** Force-route to stderr regardless of `GAN_RUN_ID`. */
  forceStderr?: boolean;
}

/** A single log entry. Free-form `meta` is serialised as-is. */
export interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: string;
  [field: string]: unknown;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  /** Returns the active sink: `'stderr'` or the absolute log file path. */
  sink(): string;
}

const FORBIDDEN_META_KEYS = new Set(['value', 'overlay', 'overlayContents', 'trustHash', 'hash']);

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
 * Construct a logger respecting the per-run routing rule.
 *
 * Note: the file sink is created lazily on first write so that constructing a
 * logger for a non-existent project root does not eagerly fail.
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
        // If the file sink fails, fall back to stderr so we don't drop the line.
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
