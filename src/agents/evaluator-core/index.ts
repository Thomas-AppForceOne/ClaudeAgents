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

export type {
  AuditCmd,
  EvaluatorCoreSnapshot,
  EvaluatorPlan,
  SecuritySurface,
  SprintPlan,
  WorktreeState,
} from './types.js';
