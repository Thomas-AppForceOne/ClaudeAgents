

/**
 * Builder for {@link EvaluatorPlan.auditCommands}: collects the audit command
 * each active stack declares.
 */

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

/**
 * Emit one audit-command row per stack that declares an `auditCmd`, sorted by
 * stack name for determinism.
 *
 * Stacks without an audit command are skipped, so a stack contributes at most
 * one row and may contribute none. The `absenceSignal` is carried through as
 * data; this builder takes no action on a missing command itself. Pure and
 * non-throwing; never returns `undefined`.
 *
 * @param snapshot resolved config; only `activeStacks[].auditCmd` is read.
 * @returns audit rows, one per declaring stack, ordered by stack name.
 */
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
