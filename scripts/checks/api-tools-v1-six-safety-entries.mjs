#!/usr/bin/env node
/*
 * Regression check: schemas/api-tools-v1.json carries exactly the six new
 * safety tool entries this sprint added (additive on v1, no v2 introduced),
 * and the sprint-1/sprint-2 entries are still present.
 *
 * Asserts:
 *  - every name in the six-safety-tool list is a key under `properties`;
 *  - every name in the eleven-trace-tool list (sprint 2) is still present;
 *  - every name in the four run-context-tool list (sprint 1) is still present;
 *  - `$id` still names api-tools-v1 (no v2 introduced);
 *  - the six safety names also appear under top-level `required`.
 *
 * Exits non-zero on any deviation. Run from the worktree root.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const expectedSafety = [
  'checkRoleCeiling',
  'checkSprintBudget',
  'detectEditOscillation',
  'createLoopDetectedError',
  'createSprintBudgetError',
  'createEditOscillationError',
];

const expectedTracePrior = [
  'emitTraceEvent',
  'runSprintSummary',
  'formatHeartbeat',
  'formatLlmCallSummary',
  'aggregateRunSummary',
  'reconcileTraceIndex',
  'reconstructRecoveryState',
  'buildTrustEventBody',
  'buildValidationAbortBody',
  'buildValidationAbortFromCode',
  'buildLoopDetectedBody',
];

const expectedRunContextPrior = [
  'resolveRunStore',
  'createRunWorkspace',
  'acquireRunLock',
  'releaseRunLock',
];

const schemaPath = path.resolve(process.cwd(), 'schemas/api-tools-v1.json');
let raw;
try {
  raw = readFileSync(schemaPath, 'utf8');
} catch (e) {
  console.error(`api-tools-v1-six-safety-entries: cannot read ${schemaPath}: ${e.message}`);
  process.exit(1);
}
let schema;
try {
  schema = JSON.parse(raw);
} catch (e) {
  console.error(`api-tools-v1-six-safety-entries: cannot parse ${schemaPath}: ${e.message}`);
  process.exit(1);
}

const props = schema.properties ?? {};
const required = new Set(schema.required ?? []);
const missing = [];
for (const name of expectedSafety) {
  if (!Object.prototype.hasOwnProperty.call(props, name)) missing.push(`${name} (properties)`);
  if (!required.has(name)) missing.push(`${name} (required)`);
}
for (const name of expectedTracePrior) {
  if (!Object.prototype.hasOwnProperty.call(props, name))
    missing.push(`${name} (properties, prior)`);
}
for (const name of expectedRunContextPrior) {
  if (!Object.prototype.hasOwnProperty.call(props, name))
    missing.push(`${name} (properties, prior)`);
}
if (missing.length > 0) {
  console.error(`api-tools-v1-six-safety-entries: missing entries: ${missing.join(', ')}`);
  process.exit(1);
}

// Schema stays on v1 — the $id must still name the v1 catalog.
const id = schema.$id ?? '';
if (!/api-tools-v1\.json$/.test(id)) {
  console.error(`api-tools-v1-six-safety-entries: $id is not the v1 catalog: ${id}`);
  process.exit(1);
}

console.log(
  'api-tools-v1-six-safety-entries: ok (6 new safety entries present, schema on v1, prior 11 trace + 4 run-context entries preserved)',
);
