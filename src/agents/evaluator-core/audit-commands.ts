/**
 * Per-stack `auditCmd` resolution.
 *
 * For each active stack that declares an `auditCmd`, emits one row with
 * the verbatim command, the stack's `absenceSignal`, and the stack name
 * for provenance. Stacks without `auditCmd` are silently skipped (the
 * absence is itself the signal — there is no implicit "no audit
 * tool" entry).
 *
 * All commands flow from `snapshot.activeStacks[*].auditCmd` — the
 * carve-out hard-codes no ecosystem-specific audit tooling. This is
 * what makes the multi-stack guard rail (synthetic-second + polyglot
 * fixtures + `lint-no-stack-leak`) correct by construction.
 *
 * Result is sorted by `stack` so the plan output is deterministic.
 */

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

export function buildAuditCommands(
  snapshot: EvaluatorCoreSnapshot,
): EvaluatorPlan['auditCommands'] {
  const rows: EvaluatorPlan['auditCommands'] = [];
  for (const stack of snapshot.activeStacks) {
    if (!stack.auditCmd) continue;
    rows.push({
      stack: stack.name,
      command: stack.auditCmd.command,
      absenceSignal: stack.auditCmd.absenceSignal,
    });
  }
  rows.sort((a, b) =>
    a.stack.localeCompare(b.stack, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return rows;
}
