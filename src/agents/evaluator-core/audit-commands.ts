

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
