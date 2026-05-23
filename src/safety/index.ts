/**
 * Public barrel for the `safety` subsystem — the framework-owned loop/thrash
 * detection layer (A1).
 *
 * Re-exports the pure per-role attempt-ceiling check, the sprint-wide
 * attempt-budget check, their shared `LoopDetected` error fields/factories and
 * evidence types/validators, the default seed ceiling table and seed budget, and
 * the user-facing halt-message renderers. This is the only import surface other
 * subsystems should depend on. Pure re-exports — no runtime behaviour of its own.
 */

export {
  DEFAULT_ATTEMPT_CEILINGS,
  checkRoleCeiling,
  buildRoleCeilingEvidence,
  isRoleCeilingEvidence,
  isRoleCeilingEvidenceEntry,
  renderRoleCeilingMessage,
  createLoopDetectedError,
  type LoopDetectedReason,
  type LoopDetectedFields,
  type RoleCeilingEvidenceEntry,
  type CeilingDecision,
  type CheckRoleCeilingInput,
} from './loop-detection.js';

export {
  DEFAULT_SPRINT_BUDGET,
  SPRINT_ROLE,
  checkSprintBudget,
  buildSprintBudgetEvidence,
  isSprintBudgetEvidence,
  renderSprintBudgetMessage,
  createSprintBudgetError,
  type SprintBudgetEvidence,
  type CheckSprintBudgetInput,
} from './sprint-budget.js';
