

/**
 * Public entry point for the evaluator-core planning layer.
 *
 * This barrel is the only surface other packages import; it re-exports the
 * plan builder, the individually-callable sub-builders that callers may want
 * in isolation, and the plan/config type vocabulary. The internal helpers
 * (`surface-instantiation`, `secrets-scans`, etc.) are deliberately not
 * re-exported — they are implementation detail behind these entry points.
 */

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
