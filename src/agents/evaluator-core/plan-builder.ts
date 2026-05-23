

import { buildAuditCommands } from './audit-commands.js';
import { buildDocLintInvocations } from './doc-lint-invocations.js';
import { buildBuildTestLint } from './build-test-lint.js';
import { buildEvaluatorAdditionalChecks } from './additional-checks.js';
import { buildDocumentationSurfacesInstantiated } from './documentation-surfaces.js';
import { buildSecretsScans } from './secrets-scans.js';
import { buildSecuritySurfacesInstantiated } from './security-surfaces.js';
import type {
  EvaluatorCoreSnapshot,
  EvaluatorPlan,
  SprintPlan,
  WorktreeState,
} from './types.js';

/**
 * Top-level orchestrator for the evaluator-core layer: turns the resolved
 * config plus the sprint/worktree inputs into a single deterministic
 * {@link EvaluatorPlan}.
 *
 * It is a pure assembly step — each plan field is delegated to a focused
 * sub-builder and the results are stitched together; no field-building logic
 * lives here. The function is side-effect-free and never throws on its own:
 * any throw would originate inside a delegate. Determinism (sorted arrays) is
 * each sub-builder's responsibility, not this function's.
 *
 * @param snapshot the resolved-config view (active stacks + splice points).
 * @param sprintPlan the sprint's affected files, used to scope surfaces.
 * @param worktreeState the worktree's files/contents, used for secrets scans
 *   and keyword-triggered surfaces.
 * @returns a fully-populated, deterministically-ordered evaluator plan.
 */
export function buildEvaluatorPlan(
  snapshot: EvaluatorCoreSnapshot,
  sprintPlan: SprintPlan,
  worktreeState: WorktreeState,
): EvaluatorPlan {
  return {
    activeStacks: buildActiveStacks(snapshot),
    secretsScans: buildSecretsScans(snapshot, worktreeState),
    auditCommands: buildAuditCommands(snapshot),
    docLintInvocations: buildDocLintInvocations(snapshot),
    buildTestLint: buildBuildTestLint(snapshot),
    securitySurfacesInstantiated: buildSecuritySurfacesInstantiated(
      snapshot,
      sprintPlan,
      worktreeState,
    ),
    documentationSurfacesInstantiated: buildDocumentationSurfacesInstantiated(
      snapshot,
      sprintPlan,
      worktreeState,
    ),
    evaluatorAdditionalChecks: buildEvaluatorAdditionalChecks(snapshot),
  };
}

/**
 * Reduce the snapshot's active stacks to the plan's `{ name, scope }` view,
 * sorted by name for determinism.
 *
 * `scope` is copied with `.slice()` so the returned plan never aliases the
 * snapshot's arrays — a later mutation of the plan cannot bleed back into the
 * caller's input. The sort is locale-aware but case-sensitive
 * (`sensitivity: 'variant'`) and non-numeric so ordering is stable and
 * reproducible across platforms rather than locale-dependent.
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
