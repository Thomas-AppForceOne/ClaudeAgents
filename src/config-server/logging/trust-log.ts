/**
 * Append-only audit trail for trust decisions (approve/revoke).
 *
 * Each call records one line in a per-run `trust.log`, giving the `/gan` run a
 * tamper-evident record of when a project was approved or revoked and against
 * which content hash. Two deliberate properties:
 * - It is a no-op outside a run (no `GAN_RUN_ID`): the audit trail only makes
 *   sense scoped to a run, and writing elsewhere would leak into the user's cwd.
 * - Each event is collapsed to exactly one physical line, so the file is a
 *   clean JSON-lines stream that downstream tooling can read line-by-line.
 */

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../determinism/index.js';

/**
 * A single trust audit event.
 *
 * @property action the verb being recorded (e.g. `'approve'`, `'revoke'`).
 * @property projectRoot the project the decision applies to (raw, as supplied
 *   by the caller).
 * @property hash optional aggregate content hash pinned by the decision;
 *   present for approvals, absent for revokes.
 * @property result optional outcome qualifier (e.g. `'approved'`, `'revoked'`,
 *   `'no-op'`).
 */
export interface TrustLogEvent {

  action: string;

  projectRoot: string;

  hash?: string;

  result?: string;
}

/**
 * Record a trust event to the current run's audit log.
 *
 * @param event see {@link TrustLogEvent}. `hash`/`result` are written only
 *   when present, so the line stays minimal.
 *
 * Side effect: appends one line to
 * `<cwd>/.gan-state/runs/<GAN_RUN_ID>/logs/trust.log`, creating directories as
 * needed. Returns silently (no throw, no write) when `GAN_RUN_ID` is unset or
 * empty. Writes are best-effort: an I/O failure drops the event rather than
 * throwing or falling back to stderr — see the catch below for why.
 */
export function logTrustEvent(event: TrustLogEvent): void {
  const runId = process.env.GAN_RUN_ID;
  if (typeof runId !== 'string' || runId.length === 0) {
    // Not inside a /gan run: there is no per-run audit file to write to, and
    // writing anywhere else would pollute the user's working directory.
    return;
  }

  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    action: event.action,
    projectRoot: event.projectRoot,
  };
  if (event.hash !== undefined) payload['hash'] = event.hash;
  if (event.result !== undefined) payload['result'] = event.result;

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

// Flatten the pretty-printed (multi-line, indented) stableStringify output
// into a single JSON-lines record: strip the trailing newline, replace every
// internal line break plus its following indentation with a single space, then
// re-append exactly one newline as the record terminator.
function collapseToOneLine(s: string): string {

  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;

  const oneLine = trimmed.replace(/\r?\n\s*/g, ' ');
  return oneLine + '\n';
}
