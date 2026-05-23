

/**
 * Builder for {@link EvaluatorPlan.buildTestLint}: picks the build, test, and
 * lint commands the evaluator should run from across the active stacks.
 */

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

/**
 * Choose a single build, test, and lint command by a deterministic
 * first-non-empty-wins rule.
 *
 * Stacks are visited in name order and each of the three commands is filled
 * independently from the first stack (in that order) that supplies a non-empty
 * string for it. The three need not come from the same stack. A field stays
 * absent from the result if no stack supplies it — the returned object is
 * sparse, never carrying `undefined` values.
 *
 * @param snapshot resolved config; reads `activeStacks[].{build,test,lint}Cmd`.
 * @returns `{ buildCmd?, testCmd?, lintCmd? }` with each present field set to
 *   the first non-empty command found in stack-name order.
 */
export function buildBuildTestLint(
  snapshot: EvaluatorCoreSnapshot,
): EvaluatorPlan['buildTestLint'] {
  // Copy before sorting: the snapshot's array must not be reordered in place,
  // since other builders read it independently and rely on it being pristine.
  const sorted = [...snapshot.activeStacks].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'variant', numeric: false }),
  );

  const out: EvaluatorPlan['buildTestLint'] = {};
  for (const stack of sorted) {
    // `=== undefined` guard makes the assignment first-wins: once a command is
    // chosen from an earlier stack it is never overwritten by a later one.
    if (out.buildCmd === undefined && typeof stack.buildCmd === 'string' && stack.buildCmd.length > 0) {
      out.buildCmd = stack.buildCmd;
    }
    if (out.testCmd === undefined && typeof stack.testCmd === 'string' && stack.testCmd.length > 0) {
      out.testCmd = stack.testCmd;
    }
    if (out.lintCmd === undefined && typeof stack.lintCmd === 'string' && stack.lintCmd.length > 0) {
      out.lintCmd = stack.lintCmd;
    }
    // All three filled — remaining stacks cannot change the result, so stop
    // early rather than scan the rest.
    if (
      out.buildCmd !== undefined &&
      out.testCmd !== undefined &&
      out.lintCmd !== undefined
    ) {
      break;
    }
  }
  return out;
}
