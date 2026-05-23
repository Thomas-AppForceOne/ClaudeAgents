

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
