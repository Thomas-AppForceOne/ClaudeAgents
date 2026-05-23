

import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';

import { stableStringify } from '../determinism/index.js';

export interface TrustLogEvent {

  action: string;

  projectRoot: string;

  hash?: string;

  result?: string;
}

export function logTrustEvent(event: TrustLogEvent): void {
  const runId = process.env.GAN_RUN_ID;
  if (typeof runId !== 'string' || runId.length === 0) {

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

function collapseToOneLine(s: string): string {

  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;

  const oneLine = trimmed.replace(/\r?\n\s*/g, ' ');
  return oneLine + '\n';
}
