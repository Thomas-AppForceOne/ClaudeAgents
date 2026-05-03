/**
 * `pairsWith.consistency` invariant (F3 catalog; sourced from M1 + C5).
 *
 * Pairing is a **one-way declaration from the module to its stack**.
 * A module's `manifest.pairsWith: <stackName>` says "I belong alongside
 * the stack named X". Stacks need NOT enumerate paired modules — the
 * back-reference graph is deliberately avoided so that a module shipped
 * to the framework after a stack is canonicalised does not require a
 * coordinated edit to the stack file.
 *
 * Four cases the invariant adjudicates (per the M1 spec + C5 + the
 * "soft-OK pairsWith" rule documented in PROJECT_CONTEXT.md):
 *
 *   1. **Soft-OK.** A module declares `pairsWith: X`; the stack `X`
 *      exists at some tier with no `pairsWith` field; the project-tier
 *      file does NOT shadow a built-in. No error.
 *
 *   2. **Disagree.** Both sides declare `pairsWith` and the values
 *      don't match. Hard error.
 *
 *   3. **Shadowed-default (C5).** A project-tier stack file shadows a
 *      canonical built-in stack file that paired with a module, but
 *      the project-tier file omits `pairsWith`. Hard error using the
 *      C5 verbatim remediation string (see SHADOWED_DEFAULT_REMEDIATION).
 *
 *   4. **Stack references missing module.** A stack's `pairsWith: M`
 *      references a module name that is not registered. Hard error.
 *
 * The C5 verbatim remediation string is reproduced byte-for-byte from
 * `specifications/C5-stack-file-resolution.md`. It is exported as a
 * named constant `SHADOWED_DEFAULT_REMEDIATION` so tests can import and
 * assert byte-equality without copy-pasting the multiline string.
 */

import path from 'node:path';

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type {
  SnapshotModuleRow,
  SnapshotStackRow,
  ValidationSnapshot,
} from '../tools/validate.js';

/**
 * Verbatim C5 remediation string for the shadowed-default case. Read
 * by `buildShadowedPairsWithMessage` and exported so test code can
 * assert byte-equality without duplicating the multiline string.
 *
 * The literal is parameterised by `<stackName>` (placeholder) — the
 * call site substitutes it via `buildShadowedPairsWithMessage`. The
 * substituted result reproduces C5's quoted block character-for-character.
 */
export const SHADOWED_DEFAULT_REMEDIATION =
  'pairs-with.consistency: project-tier stack file ".claude/gan/stacks/<stackName>.md" ' +
  'shadows the canonical "stacks/<stackName>.md" but does not declare pairsWith. The ' +
  '<stackName> module shipped by ClaudeAgents expects this stack file to declare ' +
  'pairsWith: <stackName>. Either re-declare pairsWith: <stackName> at the top of your ' +
  'project-tier file, or rename your file (e.g. .claude/gan/stacks/my-<stackName>-variant.md) ' +
  'and force its activation via stack.override in your project overlay.';

/**
 * Build the C5 shadowed-default error message by substituting
 * `<stackName>` placeholders in `SHADOWED_DEFAULT_REMEDIATION` with the
 * actual stack name. The result is byte-identical to C5's quoted block.
 */
export function buildShadowedPairsWithMessage(stackName: string): string {
  return SHADOWED_DEFAULT_REMEDIATION.split('<stackName>').join(stackName);
}

export function checkPairsWithConsistency(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];

  // --- Stack-side (C5 shadowed-default) branch ----------------------------
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

  // --- Module-side branches (M1) ------------------------------------------
  // Pre-index resolved stacks by name (highest tier wins). Resolution:
  // project > user > builtin. We pick whichever row's parsed body says
  // `name === X` (or basename === X if `name` is missing) and prefer
  // higher tiers.
  const allByName = new Map<string, SnapshotStackRow>();
  for (const tier of ['builtin', 'user', 'project'] as const) {
    for (const [name, row] of byName(collectStackRowsByTier(snapshot, tier))) {
      allByName.set(name, row);
    }
  }
  const moduleNames = new Set<string>();
  for (const m of snapshot.modules) moduleNames.add(m.name);

  // Disagree case (case 2): both sides declare pairsWith and they differ.
  for (const moduleRow of snapshot.modules) {
    if (typeof moduleRow.pairsWith !== 'string') continue;
    const stackRow = allByName.get(moduleRow.pairsWith);
    if (!stackRow) continue;
    const stackPairsWith = readPairsWith(stackRow);
    if (typeof stackPairsWith !== 'string') continue;
    if (stackPairsWith === moduleRow.name) continue;
    issues.push(buildDisagreeIssue(moduleRow, stackRow, stackPairsWith));
  }

  // Stack-references-missing-module case (case 4): a stack's pairsWith
  // names a module that is not registered.
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

/**
 * Index stack rows by stack-name. The name comes preferentially from the
 * YAML body's `name` field; if absent, falls back to the file basename
 * sans `.md` so a stack file that ships without an explicit name still
 * gets paired with its peer at another tier.
 */
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
