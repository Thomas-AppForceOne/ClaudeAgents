

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

export function buildEvaluatorAdditionalChecks(
  snapshot: EvaluatorCoreSnapshot,
): EvaluatorPlan['evaluatorAdditionalChecks'] {
  const merged = snapshot.mergedSplicePoints['evaluator.additionalChecks'] ?? [];
  return merged.map((entry) => ({
    command: entry.command,
    on_failure: entry.on_failure,
    tier: entry.tier,
  }));
}
