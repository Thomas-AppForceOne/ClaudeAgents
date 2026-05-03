/**
 * Resolves `buildCmd` / `testCmd` / `lintCmd` from the active stacks.
 *
 * The evaluator plan exposes a single `buildTestLint` object with at
 * most one value per phase. When multiple active stacks declare a
 * command for the same phase, the first stack (in name-sorted order)
 * wins. This is a conservative choice for v1: in polyglot repos with
 * conflicting commands, users should use C3's project overlay to
 * disambiguate (or scope the commands per-stack via overlays). The
 * goal here is determinism, not orchestration of multi-stack build
 * fan-out.
 *
 * Stacks that omit a phase contribute nothing for that phase. If no
 * active stack declares any command, the corresponding field is left
 * undefined (per E3 line 41 — `buildCmd?` etc. are optional).
 */

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

export function buildBuildTestLint(
  snapshot: EvaluatorCoreSnapshot,
): EvaluatorPlan['buildTestLint'] {
  const sorted = [...snapshot.activeStacks].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'variant', numeric: false }),
  );

  const out: EvaluatorPlan['buildTestLint'] = {};
  for (const stack of sorted) {
    if (out.buildCmd === undefined && typeof stack.buildCmd === 'string' && stack.buildCmd.length > 0) {
      out.buildCmd = stack.buildCmd;
    }
    if (out.testCmd === undefined && typeof stack.testCmd === 'string' && stack.testCmd.length > 0) {
      out.testCmd = stack.testCmd;
    }
    if (out.lintCmd === undefined && typeof stack.lintCmd === 'string' && stack.lintCmd.length > 0) {
      out.lintCmd = stack.lintCmd;
    }
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
