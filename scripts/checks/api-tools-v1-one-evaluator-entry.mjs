#!/usr/bin/env node
/*
 * Regression check: schemas/api-tools-v1.json carries exactly the one new
 * evaluator-core tool entry this sprint added (additive on v1, no v2
 * introduced), and the prior sprint-1/sprint-2/sprint-3 entries are still
 * present.
 *
 * Asserts:
 *  - `buildEvaluatorPlan` is a key under `properties` with an inputSchema
 *    that requires snapshot/sprintPlan/worktreeState;
 *  - `buildEvaluatorPlan` also appears under top-level `required`;
 *  - every name in the six-safety-tool list (sprint 3) is still present;
 *  - every name in the eleven-trace-tool list (sprint 2) is still present;
 *  - every name in the four run-context-tool list (sprint 1) is still
 *    present;
 *  - `$id` still names api-tools-v1 (no v2 introduced).
 *
 * Exits non-zero on any deviation. Run from the worktree root.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const expectedEvaluator = ['buildEvaluatorPlan'];

const expectedSafetyPrior = [
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
  console.error(`api-tools-v1-one-evaluator-entry: cannot read ${schemaPath}: ${e.message}`);
  process.exit(1);
}
let schema;
try {
  schema = JSON.parse(raw);
} catch (e) {
  console.error(`api-tools-v1-one-evaluator-entry: cannot parse ${schemaPath}: ${e.message}`);
  process.exit(1);
}

const props = schema.properties ?? {};
const required = new Set(schema.required ?? []);
const missing = [];
for (const name of expectedEvaluator) {
  if (!Object.prototype.hasOwnProperty.call(props, name)) missing.push(`${name} (properties)`);
  if (!required.has(name)) missing.push(`${name} (required)`);
}
for (const name of expectedSafetyPrior) {
  if (!Object.prototype.hasOwnProperty.call(props, name))
    missing.push(`${name} (properties, prior safety)`);
}
for (const name of expectedTracePrior) {
  if (!Object.prototype.hasOwnProperty.call(props, name))
    missing.push(`${name} (properties, prior trace)`);
}
for (const name of expectedRunContextPrior) {
  if (!Object.prototype.hasOwnProperty.call(props, name))
    missing.push(`${name} (properties, prior run-context)`);
}
if (missing.length > 0) {
  console.error(`api-tools-v1-one-evaluator-entry: missing entries: ${missing.join(', ')}`);
  process.exit(1);
}

// The new entry's inputSchema must require the three documented fields, so a
// caller that omits any of them fails at the schema layer rather than at
// runtime inside a library sub-builder.
const entry = props['buildEvaluatorPlan'];
const inputSchema = entry && typeof entry === 'object' ? entry.inputSchema : undefined;
const entryRequired = new Set(
  inputSchema && Array.isArray(inputSchema.required) ? inputSchema.required : [],
);
for (const field of ['snapshot', 'sprintPlan', 'worktreeState']) {
  if (!entryRequired.has(field)) {
    console.error(
      `api-tools-v1-one-evaluator-entry: buildEvaluatorPlan.inputSchema.required missing '${field}'`,
    );
    process.exit(1);
  }
}

// Schema stays on v1 — the $id must still name the v1 catalog.
const id = schema.$id ?? '';
if (!/api-tools-v1\.json$/.test(id)) {
  console.error(`api-tools-v1-one-evaluator-entry: $id is not the v1 catalog: ${id}`);
  process.exit(1);
}

console.log(
  'api-tools-v1-one-evaluator-entry: ok (1 new evaluator entry present, schema on v1, prior 6 safety + 11 trace + 4 run-context entries preserved)',
);
