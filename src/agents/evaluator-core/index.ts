/**
 * Public entry point for the E3 evaluator deterministic core (carve-out).
 *
 * Re-exports the single `buildEvaluatorPlan` function and every public
 * type the carve-out emits or accepts. Sprint 3's orchestrator (the
 * agent-prompt rewrite under E1) and `scripts/evaluator-pipeline-check`
 * import from here.
 *
 * The carve-out is deliberately pure: no file I/O, no network, no
 * environment reads. Callers assemble inputs and consume outputs.
 */

export { buildEvaluatorPlan } from './plan-builder.js';

// Surface-instantiation helpers are exported individually so the Q5
// proposer-side tests can assert documentation instantiation and the
// union existence-check in isolation, without rebuilding the whole plan.
export { buildSecuritySurfacesInstantiated } from './security-surfaces.js';
export {
  buildDocumentationSurfacesInstantiated,
  isKnownSurfaceId,
} from './documentation-surfaces.js';
// Exported individually (parallel to the surface-instantiation helpers) so
// the Q5 doc-lint emission tests can assert `buildDocLintInvocations` in
// isolation without rebuilding the whole plan.
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
