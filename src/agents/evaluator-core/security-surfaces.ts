

import { instantiateSurfaces } from './surface-instantiation.js';
import type { EvaluatorCoreSnapshot, EvaluatorPlan, SprintPlan, WorktreeState } from './types.js';

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
