#!/usr/bin/env node
/*
 * Regression check: schemas/api-tools-v1.json carries exactly the five new
 * docker module tool entries this sprint added (additive on v1, no v2
 * introduced), and every prior-sprint entry is still present.
 *
 * Asserts:
 *  - every name in the five-docker-tool list is a key under `properties`
 *    AND under top-level `required`;
 *  - every prior-sprint name (evaluator + safety + trace + run-context) is
 *    still present under `properties`;
 *  - `$id` still names api-tools-v1 (no v2 introduced).
 *
 * Exits non-zero on any deviation. Run from the worktree root.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const expectedDocker = [
  'dockerReservePort',
  'dockerReleasePort',
  'dockerDiscoverPort',
  'dockerCheckContainerHealth',
  'dockerContainerName',
];

const expectedEvaluatorPrior = ['buildEvaluatorPlan'];

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
  console.error(`api-tools-v1-five-docker-entries: cannot read ${schemaPath}: ${e.message}`);
  process.exit(1);
}
let schema;
try {
  schema = JSON.parse(raw);
} catch (e) {
  console.error(`api-tools-v1-five-docker-entries: cannot parse ${schemaPath}: ${e.message}`);
  process.exit(1);
}

const props = schema.properties ?? {};
const required = new Set(schema.required ?? []);
const missing = [];

for (const name of expectedDocker) {
  if (!Object.prototype.hasOwnProperty.call(props, name)) missing.push(`${name} (properties)`);
  if (!required.has(name)) missing.push(`${name} (required)`);
}
for (const name of expectedEvaluatorPrior) {
  if (!Object.prototype.hasOwnProperty.call(props, name))
    missing.push(`${name} (properties, prior evaluator)`);
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
  console.error(`api-tools-v1-five-docker-entries: missing entries: ${missing.join(', ')}`);
  process.exit(1);
}

// Spot-check the docker entries declare the documented required fields so a
// caller that omits one fails at the schema layer rather than at runtime.
const fieldChecks = {
  dockerReservePort: ['worktreePath', 'port', 'containerName'],
  dockerReleasePort: ['worktreePath', 'port'],
  dockerCheckContainerHealth: ['port', 'path', 'expectStatus', 'timeoutSeconds'],
  dockerContainerName: ['worktreePath'],
};
for (const [tool, fields] of Object.entries(fieldChecks)) {
  const entry = props[tool];
  const inputSchema = entry && typeof entry === 'object' ? entry.inputSchema : undefined;
  const entryRequired = new Set(
    inputSchema && Array.isArray(inputSchema.required) ? inputSchema.required : [],
  );
  for (const field of fields) {
    if (!entryRequired.has(field)) {
      console.error(
        `api-tools-v1-five-docker-entries: ${tool}.inputSchema.required missing '${field}'`,
      );
      process.exit(1);
    }
  }
}

// dockerDiscoverPort has every field optional (no required[]) — but the
// inputSchema must still pin the shape so a caller cannot smuggle in an
// unknown field.
const discoverEntry = props['dockerDiscoverPort'];
const discoverSchema =
  discoverEntry && typeof discoverEntry === 'object' ? discoverEntry.inputSchema : undefined;
if (
  !discoverSchema ||
  discoverSchema.additionalProperties !== false ||
  typeof discoverSchema.properties !== 'object'
) {
  console.error(
    'api-tools-v1-five-docker-entries: dockerDiscoverPort.inputSchema must pin additionalProperties:false',
  );
  process.exit(1);
}

// Schema stays on v1 — the $id must still name the v1 catalog.
const id = schema.$id ?? '';
if (!/api-tools-v1\.json$/.test(id)) {
  console.error(`api-tools-v1-five-docker-entries: $id is not the v1 catalog: ${id}`);
  process.exit(1);
}

console.log(
  'api-tools-v1-five-docker-entries: ok (5 new docker entries present, schema on v1, prior 1 evaluator + 6 safety + 11 trace + 4 run-context entries preserved)',
);
