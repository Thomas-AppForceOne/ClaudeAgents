/**
 * Trust-event log sink for the config server (R5 sprint 3).
 *
 * Routing rule: when `GAN_RUN_ID` is set, trust events are appended to
 * `<cwd>/.gan-state/runs/<id>/logs/trust.log`. When `GAN_RUN_ID` is
 * unset/empty (CLI mode, lint scripts, tests, ad-hoc invocations), the
 * function is a no-op — no stderr write, no file write. Trust mutations
 * surface their outcome through return values (`trustApprove` /
 * `trustRevoke`), so silencing logging outside a /gan run does not lose
 * user-visible information; it only suppresses the structured event
 * stream that exists for /gan-run forensics.
 *
 * Each in-run call writes exactly one line. Lines are serialised through
 * `stableStringify` (per F3's determinism pin) and collapsed onto a
 * single line so each `trust.log` entry is grep-able as one record.
 *
 * Anonymisation: trust hashes and project roots are *not* user-secret —
 * the trust check exposes both in user-visible error messages — so the
 * sanitisation step from `logger.ts` does not apply here. The schema is
 * fixed: `{ timestamp, action, projectRoot, hash?, result? }`.
 *
 * Locked imports per R5 S3's contract: `stableStringify` from
 * `determinism/`, `mkdirSync`/`appendFileSync` from `node:fs`, `path`
 * from `node:path`. No `JSON.stringify`, no inline crypto, no log
 * libraries.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../determinism/index.js';

export interface TrustLogEvent {
  /** Short verb. Today: `'check'`, `'approve'`, `'revoke'`. */
  action: string;
  /** Canonical absolute path of the project the event relates to. */
  projectRoot: string;
  /** Aggregate hash, if relevant for the event. Optional. */
  hash?: string;
  /** Outcome string, if relevant for the event. Optional. */
  result?: string;
}

/**
 * Append one trust event to the active trust log sink, or no-op.
 *
 * When `GAN_RUN_ID` is non-empty, the line is appended to
 * `<cwd>/.gan-state/runs/<id>/logs/trust.log` (parent dir created
 * recursively). File-write errors are swallowed — a logging failure must
 * never abort a trust check.
 *
 * When `GAN_RUN_ID` is unset or empty, the function returns immediately
 * without writing anywhere. This keeps CLI output, lint scripts, and
 * test stderr free of structured trust JSON; the trust event stream is
 * a forensic record for /gan runs only.
 */
export function logTrustEvent(event: TrustLogEvent): void {
  const runId = process.env.GAN_RUN_ID;
  if (typeof runId !== 'string' || runId.length === 0) {
    // Outside a /gan run: silent. No stderr, no file.
    return;
  }

  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    action: event.action,
    projectRoot: event.projectRoot,
  };
  if (event.hash !== undefined) payload['hash'] = event.hash;
  if (event.result !== undefined) payload['result'] = event.result;

  // `stableStringify` produces sorted-key, two-space-indent output with a
  // trailing newline. Collapse internal whitespace so the line is a
  // grep-able single record. We deliberately preserve the trailing
  // newline so consecutive calls produce one record per line.
  const multiline = stableStringify(payload);
  const line = collapseToOneLine(multiline);

  const file = path.join(process.cwd(), '.gan-state', 'runs', runId, 'logs', 'trust.log');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, line, { encoding: 'utf8' });
  } catch {
    // Logging is best-effort. Inside a /gan run the file sink is the
    // only sink; if it fails the event is dropped rather than leaked to
    // stderr (which would re-introduce the test-pollution regression).
  }
}

/**
 * Collapse the multi-line `stableStringify` output into a single record
 * line: replace every newline + indent with a single space, then ensure
 * the result ends with exactly one trailing newline.
 */
function collapseToOneLine(s: string): string {
  // `stableStringify` adds a trailing newline; strip it before collapsing.
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  // Replace every internal CR/LF (and run of leading spaces) with a single
  // space. Ajv-style `String.prototype.replaceAll` is available on Node
  // 20+ so we use the regex form for clarity.
  const oneLine = trimmed.replace(/\r?\n\s*/g, ' ');
  return oneLine + '\n';
}
