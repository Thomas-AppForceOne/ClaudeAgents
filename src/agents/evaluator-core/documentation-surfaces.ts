/**
 * Q5 layer (c) — `documentationSurfaces` template instantiation.
 *
 * Sibling of `security-surfaces.ts`: a thin adapter that selects each
 * active stack's `documentationSurfaces` array and feeds it through the
 * shared `instantiateSurfaces` core (`surface-instantiation.ts`). The
 * protocol is *identical* to the security path — Q5 mandates "the same
 * four-step C1 protocol, no new algorithm" — which is why both adapters
 * share one core rather than each owning a copy.
 */

import { instantiateSurfaces } from './surface-instantiation.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan, SprintPlan, WorktreeState } from './types.js';

/**
 * Instantiate every active stack's `documentationSurfaces` into
 * byte-stable gating contract-criterion rows.
 *
 * @param snapshot the cascaded evaluator-core snapshot; only
 *   `activeStacks[*].{name,scope,documentationSurfaces}` are read here. A
 *   stack with no `documentationSurfaces` contributes no rows.
 * @param sprintPlan the planner's sprint plan; only `affectedFiles` (the
 *   touched repo-relative paths) influences instantiation. A sprint that
 *   touches no in-scope file for a surface yields no row for it.
 * @param worktree the pre-loaded worktree state; `fileContents` supplies
 *   the text scanned for keyword triggers (e.g. `export function` for the
 *   public-contract-completeness surface). A path absent from the map
 *   matches no keyword (silent skip), so a keyworded surface whose touched
 *   files lack loaded content emits no row.
 *
 * Failure modes: pure and total — never throws. A surface that fails its
 * scope or keyword gate contributes no row rather than raising; the caller
 * (the plan-builder) depends on that purity to assemble the full plan
 * without a surface-level abort path.
 *
 * Side effects: none — a pure mapping over the inputs.
 *
 * Invariant the caller relies on: the returned array is sorted by
 * `(stack, id)` and every `templateText` equals the surface's `template`
 * byte-for-byte. The qualifier is the full `<stack>.<id>`; two stacks that
 * declare the same bare documentation-surface id therefore yield two
 * distinct rows and are never deduplicated by bare id.
 *
 * @returns the instantiated documentation-surface rows for the evaluator
 *   plan (`EvaluatorPlan['documentationSurfacesInstantiated']`).
 */
export function buildDocumentationSurfacesInstantiated(
  snapshot: EvaluatorCoreSnapshot,
  sprintPlan: SprintPlan,
  worktree: WorktreeState,
): EvaluatorPlan['documentationSurfacesInstantiated'] {
  const fileContents = worktree.fileContents ?? {};
  return instantiateSurfaces(
    snapshot.activeStacks.map((stack) => ({
      name: stack.name,
      scope: stack.scope,
      surfaces: stack.documentationSurfaces ?? [],
    })),
    sprintPlan.affectedFiles,
    fileContents,
  );
}

/**
 * Whether `qualifiedId` (a `<stack>.<surface-id>` form) names a surface
 * declared by some active stack, consulting the **union** of that stack's
 * `securitySurfaces` and `documentationSurfaces`.
 *
 * This is the existence-check C3's `proposer.suppressSurfaces` generalises
 * to under Q5: a suppression entry that targets a real security *or*
 * documentation surface is valid; one that targets neither is unknown and
 * routes to the non-aborting warning channel (per O1 / W1). The check is
 * deliberately over the union of both sets — not one set — so suppressing a
 * documentation id succeeds even though it lives in a different array than
 * the security ids the original C1 check knew about.
 *
 * @param snapshot the cascaded evaluator-core snapshot whose active stacks
 *   declare the surface arrays consulted.
 * @param qualifiedId the suppression target in `<stack>.<surface-id>`
 *   form. A bare id with no `.` separator, or a `<stack>` that is not
 *   active, returns `false` (unknown) — the suppression entry then routes
 *   to the warning channel rather than silently dropping a real surface.
 *
 * Failure modes: pure and total — never throws. An ill-formed
 * `qualifiedId` (no separator) is reported as unknown, not an error.
 *
 * Side effects: none.
 *
 * Invariant: `true` is returned only when an active stack named by the
 * qualifier prefix declares a surface whose bare id equals the qualifier
 * suffix in *either* surface family.
 *
 * @returns `true` when the qualified id is a member of the security ∪
 *   documentation surface-id union for an active stack; `false` otherwise.
 */
export function isKnownSurfaceId(
  snapshot: EvaluatorCoreSnapshot,
  qualifiedId: string,
): boolean {
  // The qualifier is `<stack>.<surface-id>`; the surface id itself may
  // contain underscores but no dot, so split on the FIRST dot only — a
  // greedy split would mis-attribute a multi-segment stack name.
  const firstDot = qualifiedId.indexOf('.');
  if (firstDot <= 0 || firstDot === qualifiedId.length - 1) return false;
  const stackName = qualifiedId.slice(0, firstDot);
  const bareId = qualifiedId.slice(firstDot + 1);

  for (const stack of snapshot.activeStacks) {
    if (stack.name !== stackName) continue;
    const securityIds = (stack.securitySurfaces ?? []).map((s) => s.id);
    const documentationIds = (stack.documentationSurfaces ?? []).map((s) => s.id);
    // Union membership: a valid suppression target lives in either family.
    if (securityIds.includes(bareId) || documentationIds.includes(bareId)) {
      return true;
    }
  }
  return false;
}
