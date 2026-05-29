#!/usr/bin/env node
/*
 * Regression check: schemas/api-tools-v1.json carries exactly the eleven new
 * trace tool entries this sprint added (additive on v1, no v2 introduced).
 *
 * Asserts:
 *  - every name in the eleven-tool list is a key under `properties`;
 *  - `$id` still names api-tools-v1 (no v2 introduced);
 *  - the eleven names also appear under top-level `required`.
 *
 * Exits non-zero on any deviation. Run from the worktree root.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const expected = [
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

const schemaPath = path.resolve(process.cwd(), 'schemas/api-tools-v1.json');
let raw;
try {
  raw = readFileSync(schemaPath, 'utf8');
} catch (e) {
  console.error(`api-tools-v1: cannot read ${schemaPath}: ${e.message}`);
  process.exit(1);
}
let schema;
try {
  schema = JSON.parse(raw);
} catch (e) {
  console.error(`api-tools-v1: cannot parse ${schemaPath}: ${e.message}`);
  process.exit(1);
}

const props = schema.properties ?? {};
const required = new Set(schema.required ?? []);
const missing = [];
for (const name of expected) {
  if (!Object.prototype.hasOwnProperty.call(props, name)) missing.push(name);
  if (!required.has(name)) missing.push(`${name} (required)`);
}
if (missing.length > 0) {
  console.error(`api-tools-v1: missing entries: ${missing.join(', ')}`);
  process.exit(1);
}

// Schema stays on v1 — the $id must still name the v1 catalog.
const id = schema.$id ?? '';
if (!/api-tools-v1\.json$/.test(id)) {
  console.error(`api-tools-v1: $id is not the v1 catalog: ${id}`);
  process.exit(1);
}

console.log('api-tools-v1: ok (11 new entries present, schema on v1)');
