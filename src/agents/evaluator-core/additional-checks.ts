

/**
 * Builder for {@link EvaluatorPlan.evaluatorAdditionalChecks}: the extra checks
 * contributed through the `evaluator.additionalChecks` config splice point.
 */

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

/**
 * Project the merged `evaluator.additionalChecks` splice entries into the
 * plan's check rows.
 *
 * Unlike the other builders this one does NOT sort: the splice point's merge
 * order is meaningful (it reflects tier precedence) and must be preserved, so
 * the rows are emitted in the order resolution produced them. An absent splice
 * point yields an empty array, never `undefined`.
 *
 * @param snapshot resolved config; only `mergedSplicePoints` is read.
 * @returns one row per merged check, copying `command`/`on_failure`/`tier`.
 */
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
