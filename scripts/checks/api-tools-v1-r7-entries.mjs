#!/usr/bin/env node
/*
 * Regression check: schemas/api-tools-v1.json carries the full set of R7
 * runtime-invocation-bridge tool entries (additive on v1, no v2 introduced),
 * with the documented required-field shapes on the entries whose mis-shape
 * would otherwise only surface at runtime.
 *
 * This is the consolidation of four per-sprint scripts (run-context, trace,
 * safety, evaluator, docker) into a single check that asserts the whole R7
 * surface at once — and, unlike its predecessors, is wired into CI
 * (.github/workflows/test-api-tools-v1-r7-entries.yml) so it actually gates
 * merges. The union of the prior scripts' field-level assertions is preserved
 * here so no coverage is dropped.
 *
 * Asserts:
 *  - every R7 tool name (4 run-context + 11 trace + 6 safety + 1 evaluator +
 *    5 docker) is a key under `properties` AND under top-level `required`;
 *  - `$id` still names api-tools-v1 (no v2 introduced);
 *  - the docker entries declare their documented required fields;
 *  - `dockerDiscoverPort` pins additionalProperties:false + minProperties:1
 *    so a no-layer `{}` call is rejected at the catalog, not at runtime;
 *  - `buildEvaluatorPlan` requires snapshot/sprintPlan/worktreeState;
 *  - `checkRoleCeiling` carries the flat property set (no nested `input`
 *    alternation that previously enabled the silent-shadow hazard).
 *
 * Exits non-zero on any deviation. Run from the worktree root.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SELF = 'api-tools-v1-r7-entries';

// Every R7 tool entry, grouped by the sprint that introduced it. All must be
// present under `properties` and `required`.
const expectedNames = {
  'run-context': ['resolveRunStore', 'createRunWorkspace', 'acquireRunLock', 'releaseRunLock'],
  trace: [
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
  ],
  safety: [
    'checkRoleCeiling',
    'checkSprintBudget',
    'detectEditOscillation',
    'createLoopDetectedError',
    'createSprintBudgetError',
    'createEditOscillationError',
  ],
  evaluator: ['buildEvaluatorPlan'],
  docker: [
    'dockerReservePort',
    'dockerReleasePort',
    'dockerDiscoverPort',
    'dockerCheckContainerHealth',
    'dockerContainerName',
  ],
};

function fail(msg) {
  console.error(`${SELF}: ${msg}`);
  process.exit(1);
}

const schemaPath = path.resolve(process.cwd(), 'schemas/api-tools-v1.json');
let raw;
try {
  raw = readFileSync(schemaPath, 'utf8');
} catch (e) {
  fail(`cannot read ${schemaPath}: ${e.message}`);
}
let schema;
try {
  schema = JSON.parse(raw);
} catch (e) {
  fail(`cannot parse ${schemaPath}: ${e.message}`);
}

const props = schema.properties ?? {};
const required = new Set(schema.required ?? []);
const missing = [];

let total = 0;
for (const [group, names] of Object.entries(expectedNames)) {
  for (const name of names) {
    total += 1;
    if (!Object.prototype.hasOwnProperty.call(props, name)) {
      missing.push(`${name} (properties, ${group})`);
    }
    if (!required.has(name)) missing.push(`${name} (required, ${group})`);
  }
}
if (missing.length > 0) fail(`missing entries: ${missing.join(', ')}`);

// Schema stays on v1 — the $id must still name the v1 catalog.
const id = schema.$id ?? '';
if (!/api-tools-v1\.json$/.test(id)) fail(`$id is not the v1 catalog: ${id}`);

// Helper: the inputSchema.required set for a tool entry.
function requiredFieldsOf(name) {
  const entry = props[name];
  const inputSchema = entry && typeof entry === 'object' ? entry.inputSchema : undefined;
  return new Set(inputSchema && Array.isArray(inputSchema.required) ? inputSchema.required : []);
}

// Docker entries declare the documented required fields so a caller that omits
// one fails at the schema layer rather than at runtime.
const dockerFieldChecks = {
  dockerReservePort: ['worktreePath', 'port', 'containerName'],
  // dockerReleasePort: library keys on worktreePath alone (idempotent
  // release), so the wire shape mirrors that — `port` is intentionally absent.
  dockerReleasePort: ['worktreePath'],
  dockerCheckContainerHealth: ['port', 'path', 'expectStatus', 'timeoutSeconds'],
  dockerContainerName: ['worktreePath'],
};
for (const [tool, fields] of Object.entries(dockerFieldChecks)) {
  const entryRequired = requiredFieldsOf(tool);
  for (const field of fields) {
    if (!entryRequired.has(field)) {
      fail(`${tool}.inputSchema.required missing '${field}'`);
    }
  }
}

// dockerDiscoverPort has every layer optional (no required[]) — but the
// inputSchema must still pin the shape (additionalProperties:false) and require
// at least one layer (minProperties:1) so a structurally-empty `{}` call is
// rejected at the catalog rather than throwing PortNotDiscovered at runtime.
const discoverEntry = props['dockerDiscoverPort'];
const discoverSchema =
  discoverEntry && typeof discoverEntry === 'object' ? discoverEntry.inputSchema : undefined;
if (
  !discoverSchema ||
  discoverSchema.additionalProperties !== false ||
  typeof discoverSchema.properties !== 'object'
) {
  fail('dockerDiscoverPort.inputSchema must pin additionalProperties:false');
}
if (discoverSchema.minProperties !== 1) {
  fail(
    'dockerDiscoverPort.inputSchema must set minProperties:1 so a no-layer call is ' +
      'rejected at the catalog, not at runtime',
  );
}

// buildEvaluatorPlan's inputSchema must require the three documented fields, so
// a caller that omits any of them fails at the schema layer rather than at
// runtime inside a library sub-builder.
const evaluatorRequired = requiredFieldsOf('buildEvaluatorPlan');
for (const field of ['snapshot', 'sprintPlan', 'worktreeState']) {
  if (!evaluatorRequired.has(field)) {
    fail(`buildEvaluatorPlan.inputSchema.required missing '${field}'`);
  }
}

// Pin the flat property set on `checkRoleCeiling`. A JSON Schema that admits a
// nested `input` alternation re-enables the silent-shadow hazard; the contract
// is flat-only and matches the sibling safety tools. Both `properties` keys and
// `required` must be exactly the flat set.
const expectedRoleCeiling = ['attemptState', 'ceilings', 'evidence', 'role'].sort();
const roleCeilingProps = Object.keys(props['checkRoleCeiling']?.inputSchema?.properties ?? {}).sort();
if (roleCeilingProps.join(',') !== expectedRoleCeiling.join(',')) {
  fail(
    `checkRoleCeiling properties drift — expected [${expectedRoleCeiling.join(', ')}], ` +
      `saw [${roleCeilingProps.join(', ')}]`,
  );
}
const roleCeilingRequired = [...(props['checkRoleCeiling']?.inputSchema?.required ?? [])].sort();
if (roleCeilingRequired.join(',') !== expectedRoleCeiling.join(',')) {
  fail(
    `checkRoleCeiling required drift — expected [${expectedRoleCeiling.join(', ')}], ` +
      `saw [${roleCeilingRequired.join(', ')}]`,
  );
}

console.log(
  `${SELF}: ok (${total} R7 entries present under properties+required, schema on v1; ` +
    'docker required-fields + dockerDiscoverPort shape + buildEvaluatorPlan required-fields + ' +
    'checkRoleCeiling flat-only all verified)',
);
