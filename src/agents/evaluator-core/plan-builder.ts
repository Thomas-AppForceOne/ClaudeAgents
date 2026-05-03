/**
 * Top-level entry point for the E3 evaluator deterministic core.
 *
 * `buildEvaluatorPlan(snapshot, sprintPlan, worktreeState)` is a pure
 * function: same inputs produce byte-identical output across calls and
 * processes. It orchestrates the per-concern helpers:
 *
 *   - active stacks  → name + scope, sorted by name (E3 line 104)
 *   - secretsScans   → per-stack secretsGlob expansion against scope
 *   - auditCommands  → per-stack auditCmd (verbatim)
 *   - buildTestLint  → first-active-stack-wins per phase
 *   - securitySurfacesInstantiated → C1 template instantiation
 *   - evaluatorAdditionalChecks    → cascaded splice point passthrough
 *
 * The carve-out reads no files. Callers (the orchestrator script in
 * `scripts/evaluator-pipeline-check/` per E3 line 112) are responsible
 * for assembling the snapshot from `getResolvedConfig()` plus parsed
 * stack bodies, the sprint plan from the planner agent's output, and
 * the worktree state from a file enumeration plus pre-loaded contents
 * for keyword matching.
 */

import { buildAuditCommands } from './audit-commands.js';
import { buildBuildTestLint } from './build-test-lint.js';
import { buildEvaluatorAdditionalChecks } from './additional-checks.js';
import { buildSecretsScans } from './secrets-scans.js';
import { buildSecuritySurfacesInstantiated } from './security-surfaces.js';
import type {
  EvaluatorCoreSnapshot,
  EvaluatorPlan,
  SprintPlan,
  WorktreeState,
} from './types.js';

export function buildEvaluatorPlan(
  snapshot: EvaluatorCoreSnapshot,
  sprintPlan: SprintPlan,
  worktreeState: WorktreeState,
): EvaluatorPlan {
  return {
    activeStacks: buildActiveStacks(snapshot),
    secretsScans: buildSecretsScans(snapshot, worktreeState),
    auditCommands: buildAuditCommands(snapshot),
    buildTestLint: buildBuildTestLint(snapshot),
    securitySurfacesInstantiated: buildSecuritySurfacesInstantiated(
      snapshot,
      sprintPlan,
      worktreeState,
    ),
    evaluatorAdditionalChecks: buildEvaluatorAdditionalChecks(snapshot),
  };
}

/**
 * Active stacks list, sorted by `name` per E3 normalisation rule (line
 * 104). The `scope` array is preserved in declaration order — it is
 * the stack file's authoritative ordering and downstream consumers
 * should treat it as opaque.
 */
function buildActiveStacks(snapshot: EvaluatorCoreSnapshot): EvaluatorPlan['activeStacks'] {
  const rows = snapshot.activeStacks.map((s) => ({
    name: s.name,
    scope: s.scope.slice(),
  }));
  rows.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return rows;
}
