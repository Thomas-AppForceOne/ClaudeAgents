

/**
 * Builder for {@link EvaluatorPlan.docLintInvocations}: collects the
 * documentation-lint command each active stack declares, with the scope and
 * thresholds the evaluator needs to run and grade it.
 */

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

// Default measurement mode when a stack's docLintCmd omits `baseline`: count
// only newly-introduced doc issues ('delta') rather than every existing one.
// Centralised so the fallback is defined in exactly one place.
const DEFAULT_BASELINE = 'delta' as const;

/**
 * Emit one doc-lint invocation per stack that declares a `docLintCmd`, sorted
 * by stack name for determinism.
 *
 * Stacks without a doc-lint command are skipped. Each row carries a *copy* of
 * the stack's `scope` (via `.slice()`, so the plan never aliases the snapshot)
 * and the command's `severity`/`absenceSignal` verbatim. `baseline` is
 * resolved here: a stack that omits it gets {@link DEFAULT_BASELINE}, so the
 * emitted row's `baseline` is always concrete (never `undefined`). Pure and
 * non-throwing.
 *
 * @param snapshot resolved config; reads `activeStacks[].docLintCmd` and
 *   `.scope`.
 * @returns doc-lint rows, one per declaring stack, ordered by stack name.
 */
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
