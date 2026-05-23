/**
 * C1 `securitySurfaces` template instantiation.
 *
 * Thin adapter over the shared `instantiateSurfaces` core
 * (`surface-instantiation.ts`): it selects each active stack's
 * `securitySurfaces` array and feeds it through the C1 protocol. The
 * algorithm itself (scope ∩ stack-scope intersect, keyword gate, verbatim
 * template, cross-contamination guard, `(stack, id)` byte-stable sort)
 * lives in the shared core so the security and documentation families
 * cannot drift apart — see `surface-instantiation.ts` for the protocol.
 */

import { instantiateSurfaces } from './surface-instantiation.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan, SprintPlan, WorktreeState } from './types.js';

/**
 * Instantiate every active stack's `securitySurfaces` into byte-stable
 * contract-criterion rows.
 *
 * @param snapshot the cascaded evaluator-core snapshot; only
 *   `activeStacks[*].{name,scope,securitySurfaces}` are read here.
 * @param sprintPlan the planner's sprint plan; only `affectedFiles` (the
 *   touched repo-relative paths) influences instantiation.
 * @param worktree the pre-loaded worktree state; `fileContents` supplies
 *   the text scanned for keyword triggers. A missing entry matches no
 *   keyword (silent skip).
 *
 * Failure modes: pure and total — never throws. A surface that fails any
 * gate contributes no row.
 *
 * Side effects: none. Invariant: output sorted by `(stack, id)`, every
 * `templateText` equals the surface `template` verbatim.
 *
 * @returns the instantiated security-surface rows for the evaluator plan.
 */
export function buildSecuritySurfacesInstantiated(
  snapshot: EvaluatorCoreSnapshot,
  sprintPlan: SprintPlan,
  worktree: WorktreeState,
): EvaluatorPlan['securitySurfacesInstantiated'] {
  const fileContents = worktree.fileContents ?? {};
  return instantiateSurfaces(
    snapshot.activeStacks.map((stack) => ({
      name: stack.name,
      scope: stack.scope,
      surfaces: stack.securitySurfaces ?? [],
    })),
    sprintPlan.affectedFiles,
    fileContents,
  );
}
