

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

const DEFAULT_BASELINE = 'delta' as const;

export function buildDocLintInvocations(
  snapshot: EvaluatorCoreSnapshot,
): EvaluatorPlan['docLintInvocations'] {
  const rows: EvaluatorPlan['docLintInvocations'] = [];
  for (const stack of snapshot.activeStacks) {

    if (!stack.docLintCmd) continue;
    rows.push({
      stack: stack.name,
      command: stack.docLintCmd.command,

      scope: stack.scope.slice(),
      severity: stack.docLintCmd.severity,

      baseline: stack.docLintCmd.baseline ?? DEFAULT_BASELINE,
      absenceSignal: stack.docLintCmd.absenceSignal,
    });
  }

  rows.sort((a, b) =>
    a.stack.localeCompare(b.stack, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return rows;
}
