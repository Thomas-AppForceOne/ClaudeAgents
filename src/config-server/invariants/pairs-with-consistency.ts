/**
 * `pairsWith.consistency` invariant (F3 catalog; sourced from M1 + C5).
 *
 * Two enforcement branches share this file:
 *
 *  1. **Module side (M1).** When `src/modules/<name>/` and
 *     `stacks/<name>.md` both exist, both must declare `pairsWith`
 *     referring to each other. Until M1 ships and `snapshot.modules` is
 *     populated, this branch is a no-op (R1's "module surface no-op
 *     contract" — see PROJECT_CONTEXT.md). When M1 lands, the existing
 *     module rows feed into this branch without changing the function
 *     signature.
 *
 *  2. **Stack side (C5 shadowed-default).** When a project-tier stack
 *     file shadows a canonical built-in stack file, but the project-tier
 *     file *omits* a `pairsWith` declaration that the built-in carried,
 *     this invariant fires with the **C5 verbatim remediation hint**.
 *     The string template lives below; it is reproduced byte-for-byte
 *     from `specifications/C5-stack-file-resolution.md`.
 *
 * Per S4's "no new error codes" rule, both branches surface as
 * `InvariantViolation` issues.
 */

import path from 'node:path';

import { createError } from '../errors.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

/**
 * Build the C5 shadowed-default error message.
 *
 * The string is reproduced byte-for-byte from C5
 * (`specifications/C5-stack-file-resolution.md`), with the substituted
 * fields:
 *   - the offending project-tier file path (relative to the project
 *     root, with forward-slash separators — the exact form C5 uses);
 *   - the canonical built-in path (relative, forward-slash);
 *   - the example "rename your file (e.g. ...)" path, derived from the
 *     stack name;
 *   - the expected `pairsWith` value (== the stack name).
 *
 * The wording around the substitutions ("shadows the canonical … but
 * does not declare pairsWith. The X module shipped by ClaudeAgents
 * expects … Either re-declare pairsWith: X at the top of your
 * project-tier file, or rename your file (e.g. …) and force its
 * activation via stack.override in your project overlay.") is identical
 * to C5's quoted block.
 */
export function buildShadowedPairsWithMessage(stackName: string): string {
  const projectRel = `.claude/gan/stacks/${stackName}.md`;
  const builtinRel = `stacks/${stackName}.md`;
  const renamedExample = `.claude/gan/stacks/my-${stackName}-variant.md`;
  return (
    `pairs-with.consistency: project-tier stack file "${projectRel}" shadows the canonical ` +
    `"${builtinRel}" but does not declare pairsWith. The ${stackName} module shipped by ` +
    `ClaudeAgents expects this stack file to declare pairsWith: ${stackName}. Either ` +
    `re-declare pairsWith: ${stackName} at the top of your project-tier file, or ` +
    `rename your file (e.g. ${renamedExample}) and force its activation via ` +
    `stack.override in your project overlay.`
  );
}

export function checkPairsWithConsistency(snapshot: ValidationSnapshot): Issue[] {
  const issues: Issue[] = [];

  // --- Stack-side (C5 shadowed-default) branch ----------------------------
  // Pair every project-tier row with the built-in row of the same stack
  // name. If the built-in declares `pairsWith: X` and the project-tier
  // file omits `pairsWith`, fire the C5 verbatim error.
  const projectRows = collectStackRowsByTier(snapshot, 'project');
  const builtinRows = collectStackRowsByTier(snapshot, 'builtin');
  const projectByName = byName(projectRows, snapshot.projectRoot);
  const builtinByName = byName(builtinRows, snapshot.projectRoot);
  for (const [name, projectRow] of projectByName) {
    const builtinRow = builtinByName.get(name);
    if (!builtinRow) continue;
    const builtinPairsWith = readPairsWith(builtinRow);
    if (typeof builtinPairsWith !== 'string') continue;
    const projectPairsWith = readPairsWith(projectRow);
    if (typeof projectPairsWith === 'string') continue;
    // Confirmed: project-tier shadows a paired built-in but omits
    // `pairsWith`. Reproduce C5's verbatim wording.
    const messageBody = buildShadowedPairsWithMessage(name);
    // Build via the central error factory so the wording stays alongside
    // the rest of the invariant violations if a dedicated factory branch
    // is ever added.
    const err = createError('InvariantViolation', { message: messageBody });
    issues.push({
      code: 'InvariantViolation',
      path: projectRow.path,
      field: '/pairsWith',
      message: err.message,
      severity: 'error',
    });
  }

  // --- Module-side (M1) branch -------------------------------------------
  // OQ4 / R1 module surface no-op contract: `snapshot.modules` is empty
  // until M1 ships. We iterate it for shape readiness; today the loop
  // body never executes. When M1 lands, each module row will carry a
  // `name` + `pairsWith` and we'll cross-check those against the matching
  // stack row's `pairsWith`.
  for (const _module of snapshot.modules as unknown[]) {
    // Intentionally empty: M1 will populate this branch.
    void _module;
  }

  return issues;
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
function byName(rows: SnapshotStackRow[], projectRoot: string): Map<string, SnapshotStackRow> {
  const out = new Map<string, SnapshotStackRow>();
  for (const row of rows) {
    const name = stackName(row, projectRoot);
    if (name) out.set(name, row);
  }
  return out;
}

function stackName(row: SnapshotStackRow, projectRoot: string): string | null {
  if (row.data && isObject(row.data)) {
    const declared = row.data['name'];
    if (typeof declared === 'string' && declared.length > 0) return declared;
  }
  // Fallback: basename of the file without `.md`. `path.basename` works
  // even for paths under the project root that have not been resolved.
  void projectRoot;
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
