

export { buildEvaluatorPlan } from './plan-builder.js';

export { buildSecuritySurfacesInstantiated } from './security-surfaces.js';
export {
  buildDocumentationSurfacesInstantiated,
  isKnownSurfaceId,
} from './documentation-surfaces.js';

export { buildDocLintInvocations } from './doc-lint-invocations.js';

export type {
  AuditCmd,
  DocLintCmd,
  DocumentationSurface,
  EvaluatorCoreSnapshot,
  EvaluatorPlan,
  SecuritySurface,
  SprintPlan,
  WorktreeState,
} from './types.js';
