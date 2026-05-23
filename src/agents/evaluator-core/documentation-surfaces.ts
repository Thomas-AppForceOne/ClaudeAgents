

import { instantiateSurfaces } from './surface-instantiation.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan, SprintPlan, WorktreeState } from './types.js';

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

export function isKnownSurfaceId(
  snapshot: EvaluatorCoreSnapshot,
  qualifiedId: string,
): boolean {

  const firstDot = qualifiedId.indexOf('.');
  if (firstDot <= 0 || firstDot === qualifiedId.length - 1) return false;
  const stackName = qualifiedId.slice(0, firstDot);
  const bareId = qualifiedId.slice(firstDot + 1);

  for (const stack of snapshot.activeStacks) {
    if (stack.name !== stackName) continue;
    const securityIds = (stack.securitySurfaces ?? []).map((s) => s.id);
    const documentationIds = (stack.documentationSurfaces ?? []).map((s) => s.id);

    if (securityIds.includes(bareId) || documentationIds.includes(bareId)) {
      return true;
    }
  }
  return false;
}
