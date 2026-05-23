

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
