/**
 * Invariant `pairsWith.consistency`: keep the `pairsWith` link between a stack
 * file and the module it belongs to coherent across tiers.
 *
 * A module and a stack can declare they pair with each other via a `pairsWith`
 * field. This invariant enforces three distinct rules, all at `error` severity:
 *
 * 1. **Shadowed default drops the pairing.** A project-tier stack file that
 *    shadows a same-named built-in declaring `pairsWith` must re-declare it; an
 *    override that silently loses the pairing would detach the stack from its
 *    module. (See {@link SHADOWED_DEFAULT_REMEDIATION}.)
 * 2. **Two-sided disagreement.** If a module names a stack via `pairsWith` and
 *    that stack also declares `pairsWith`, the stack's value must point back at
 *    the module — otherwise the two sides disagree.
 * 3. **Dangling stack reference.** A stack whose `pairsWith` names a module
 *    that is not registered is reported so the typo/missing-module is caught.
 *
 * Stack identity is by declared `name`, falling back to the filename stem.
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
 * Remediation template for rule 1 (a project-tier file shadowing a built-in
 * that declared `pairsWith`). `<stackName>` is a placeholder substituted with
 * the real stack name by {@link buildShadowedPairsWithMessage}. Exported so
 * tests can assert against the canonical wording without duplicating it.
 */
export const SHADOWED_DEFAULT_REMEDIATION =
  'pairs-with.consistency: project-tier stack file ".claude/gan/stacks/<stackName>.md" ' +
  'shadows the canonical "stacks/<stackName>.md" but does not declare pairsWith. The ' +
  '<stackName> module shipped by ClaudeAgents expects this stack file to declare ' +
  'pairsWith: <stackName>. Either re-declare pairsWith: <stackName> at the top of your ' +
  'project-tier file, or rename your file (e.g. .claude/gan/stacks/my-<stackName>-variant.md) ' +
  'and force its activation via stack.override in your project overlay.';

/**
 * Substitute the real stack name into {@link SHADOWED_DEFAULT_REMEDIATION}.
 * Every `<stackName>` placeholder is replaced (split/join, not regex, so a name
 * containing regex-special characters is handled literally).
 *
 * @param stackName the shadowed stack's name.
 */
export function buildShadowedPairsWithMessage(stackName: string): string {
  return SHADOWED_DEFAULT_REMEDIATION.split('<stackName>').join(stackName);
}

/**
 * Run all three pairsWith-consistency rules against the snapshot.
 *
 * Reads `snapshot.stackFiles` and `snapshot.modules`; pure and never throws on
 * a normal outcome.
 *
 * @param snapshot the validation snapshot.
 * @returns all `error` {@link Issue}s from the three rules, concatenated in
 *   rule order (shadowed-default, then disagreement, then dangling reference);
 *   empty when the pairsWith graph is coherent. Each issue is attributed to the
 *   stack file at fault (rule 1 to the project-tier file; rules 2 and 3 to the
 *   stack carrying the bad/dangling pairsWith).
 */
export function checkPairsWithConsistency(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];

  // Rule 1 — a project-tier file shadowing a same-named built-in must not drop
  // a pairsWith the built-in declared. We only flag the case where the built-in
  // had a pairsWith string and the shadowing project file omits it.
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

  // Build one name→row map across every tier. Inserting builtin first, then
  // user, then project means a higher-priority tier's row wins on name
  // collision — the resolved view rules 2 and 3 should judge.
  const allByName = new Map<string, SnapshotStackRow>();
  for (const tier of ['builtin', 'user', 'project'] as const) {
    for (const [name, row] of byName(collectStackRowsByTier(snapshot, tier))) {
      allByName.set(name, row);
    }
  }
  const moduleNames = new Set<string>();
  for (const m of snapshot.modules) moduleNames.add(m.name);

  // Rule 2 — a module's pairsWith and the stack's pairsWith must agree. Only
  // checked when the stack also declares pairsWith (a stack that omits it is
  // allowed; the pairing is then one-directional from the module).
  for (const moduleRow of snapshot.modules) {
    if (typeof moduleRow.pairsWith !== 'string') continue;
    const stackRow = allByName.get(moduleRow.pairsWith);
    if (!stackRow) continue;
    const stackPairsWith = readPairsWith(stackRow);
    if (typeof stackPairsWith !== 'string') continue;
    if (stackPairsWith === moduleRow.name) continue;
    issues.push(buildDisagreeIssue(moduleRow, stackRow, stackPairsWith));
  }

  // Rule 3 — every stack pairsWith must name a registered module.
  for (const [stackName, stackRow] of allByName) {
    const stackPairsWith = readPairsWith(stackRow);
    if (typeof stackPairsWith !== 'string') continue;
    if (moduleNames.has(stackPairsWith)) continue;
    issues.push(buildMissingModuleIssue(stackName, stackRow, stackPairsWith));
  }

  return issues;
}

/**
 * Build the rule-2 issue: a module and the stack it names disagree on
 * `pairsWith`. Reported against the *stack* file, since that is where the
 * conflicting value lives.
 *
 * @param moduleRow the module declaring the pairing.
 * @param stackRow the stack it pointed at.
 * @param stackPairsWith the stack's own (conflicting) pairsWith value.
 */
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

/**
 * Build the rule-3 issue: a stack's `pairsWith` names a module that is not
 * registered. Reported against the stack file.
 *
 * @param stackName the stack's resolved name (for the message).
 * @param stackRow the stack row (its `path` is the reported location).
 * @param referencedModule the unregistered module name the stack pointed at.
 */
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

/** Collect the snapshot's stack rows belonging to a single tier. */
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
 * Index rows by their resolved stack name (see {@link stackName}). Rows with no
 * derivable name are dropped; on a name collision within `rows` the later row
 * wins (last-write), so callers control precedence via insertion order.
 */
function byName(rows: SnapshotStackRow[]): Map<string, SnapshotStackRow> {
  const out = new Map<string, SnapshotStackRow>();
  for (const row of rows) {
    const name = stackName(row);
    if (name) out.set(name, row);
  }
  return out;
}

/**
 * Resolve a stack's name: the declared `name` field if present and non-empty,
 * otherwise the filename with its `.md` extension stripped. Returns `null` only
 * when there is no declared name and the path does not end in `.md` — such a
 * row cannot be matched by name and is excluded from the indexes.
 */
function stackName(row: SnapshotStackRow): string | null {
  if (row.data && isObject(row.data)) {
    const declared = row.data['name'];
    if (typeof declared === 'string' && declared.length > 0) return declared;
  }
  const base = path.basename(row.path);
  if (base.endsWith('.md')) return base.slice(0, -3);
  return null;
}

/**
 * Read a stack's raw `pairsWith` value (any type, or `undefined` when the body
 * is not a mapping or the field is absent). Callers narrow to `string` before
 * acting; a non-string value is treated as "no pairing declared".
 */
function readPairsWith(row: SnapshotStackRow): unknown {
  if (!row.data || !isObject(row.data)) return undefined;
  return row.data['pairsWith'];
}

/** Narrow to a non-null, non-array object (a YAML mapping). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
