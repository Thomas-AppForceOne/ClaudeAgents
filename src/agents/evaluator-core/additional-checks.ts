/**
 * Splices in `evaluator.additionalChecks` from the cascaded overlay.
 *
 * The snapshot's `mergedSplicePoints['evaluator.additionalChecks']` has
 * already been cascaded through C4's three tiers (default → user →
 * project) per C3's catalog rule (`union-by-key` on `command`, with
 * `discardInherited` semantics applied upstream). This carve-out does
 * not duplicate the cascade logic — it passes the merged list through
 * verbatim, copying entries so the caller cannot mutate the snapshot
 * by mutating the plan.
 *
 * If the splice point is absent or empty, returns `[]`.
 */

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
