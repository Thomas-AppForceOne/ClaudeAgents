

import path from 'node:path';

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type {
  SnapshotModuleRow,
  SnapshotStackRow,
  ValidationSnapshot,
} from '../tools/validate.js';

export const SHADOWED_DEFAULT_REMEDIATION =
  'pairs-with.consistency: project-tier stack file ".claude/gan/stacks/<stackName>.md" ' +
  'shadows the canonical "stacks/<stackName>.md" but does not declare pairsWith. The ' +
  '<stackName> module shipped by ClaudeAgents expects this stack file to declare ' +
  'pairsWith: <stackName>. Either re-declare pairsWith: <stackName> at the top of your ' +
  'project-tier file, or rename your file (e.g. .claude/gan/stacks/my-<stackName>-variant.md) ' +
  'and force its activation via stack.override in your project overlay.';

export function buildShadowedPairsWithMessage(stackName: string): string {
  return SHADOWED_DEFAULT_REMEDIATION.split('<stackName>').join(stackName);
}

export function checkPairsWithConsistency(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];

  const projectRows = collectStackRowsByTier(snapshot, 'project');
  const builtinRows = collectStackRowsByTier(snapshot, 'builtin');
  const projectByName = byName(projectRows);
  const builtinByName = byName(builtinRows);
  for (const [name, projectRow] of projectByName) {
    const builtinRow = builtinByName.get(name);
    if (!builtinRow) continue;
    const builtinPairsWith = readPairsWith(builtinRow);
    if (typeof builtinPairsWith !== 'string') continue;
    const projectPairsWith = readPairsWith(projectRow);
    if (typeof projectPairsWith === 'string') continue;
    const messageBody = buildShadowedPairsWithMessage(name);
    const err = createError('InvariantViolation', { message: messageBody });
    issues.push({
      code: 'InvariantViolation',
      path: projectRow.path,
      field: '/pairsWith',
      message: err.message,
      severity: 'error',
    });
  }

  const allByName = new Map<string, SnapshotStackRow>();
  for (const tier of ['builtin', 'user', 'project'] as const) {
    for (const [name, row] of byName(collectStackRowsByTier(snapshot, tier))) {
      allByName.set(name, row);
    }
  }
  const moduleNames = new Set<string>();
  for (const m of snapshot.modules) moduleNames.add(m.name);

  for (const moduleRow of snapshot.modules) {
    if (typeof moduleRow.pairsWith !== 'string') continue;
    const stackRow = allByName.get(moduleRow.pairsWith);
    if (!stackRow) continue;
    const stackPairsWith = readPairsWith(stackRow);
    if (typeof stackPairsWith !== 'string') continue;
    if (stackPairsWith === moduleRow.name) continue;
    issues.push(buildDisagreeIssue(moduleRow, stackRow, stackPairsWith));
  }

  for (const [stackName, stackRow] of allByName) {
    const stackPairsWith = readPairsWith(stackRow);
    if (typeof stackPairsWith !== 'string') continue;
    if (moduleNames.has(stackPairsWith)) continue;
    issues.push(buildMissingModuleIssue(stackName, stackRow, stackPairsWith));
  }

  return issues;
}

function buildDisagreeIssue(
  moduleRow: SnapshotModuleRow,
  stackRow: SnapshotStackRow,
  stackPairsWith: string,
): Issue {
  const message =
    `pairs-with.consistency: module '${moduleRow.name}' declares pairsWith: ${moduleRow.pairsWith}, ` +
    `but stack '${stackRow.path}' declares pairsWith: ${stackPairsWith}. ` +
    `Both sides must agree, or one side must omit pairsWith.`;
  const err = createError('InvariantViolation', { message });
  return {
    code: 'InvariantViolation',
    path: stackRow.path,
    field: '/pairsWith',
    message: err.message,
    severity: 'error',
  };
}

function buildMissingModuleIssue(
  stackName: string,
  stackRow: SnapshotStackRow,
  referencedModule: string,
): Issue {
  const message =
    `pairs-with.consistency: stack '${stackName}' declares pairsWith: ${referencedModule}, ` +
    `but no module with that name is registered. Either remove pairsWith from the stack ` +
    `file or add the missing module under src/modules/${referencedModule}/.`;
  const err = createError('InvariantViolation', { message });
  return {
    code: 'InvariantViolation',
    path: stackRow.path,
    field: '/pairsWith',
    message: err.message,
    severity: 'error',
  };
}

function collectStackRowsByTier(
  snapshot: ValidationSnapshot,
  tier: 'project' | 'user' | 'builtin',
): SnapshotStackRow[] {
  const out: SnapshotStackRow[] = [];
  for (const row of snapshot.stackFiles.values()) {
    if (row.tier === tier) out.push(row);
  }
  return out;
}

function byName(rows: SnapshotStackRow[]): Map<string, SnapshotStackRow> {
  const out = new Map<string, SnapshotStackRow>();
  for (const row of rows) {
    const name = stackName(row);
    if (name) out.set(name, row);
  }
  return out;
}

function stackName(row: SnapshotStackRow): string | null {
  if (row.data && isObject(row.data)) {
    const declared = row.data['name'];
    if (typeof declared === 'string' && declared.length > 0) return declared;
  }
  const base = path.basename(row.path);
  if (base.endsWith('.md')) return base.slice(0, -3);
  return null;
}

function readPairsWith(row: SnapshotStackRow): unknown {
  if (!row.data || !isObject(row.data)) return undefined;
  return row.data['pairsWith'];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
