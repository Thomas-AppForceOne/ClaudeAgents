/**
 * Public barrel for the `safety` subsystem — the framework-owned loop/thrash
 * detection layer (A1).
 *
 * Re-exports the pure per-role attempt-ceiling check, the sprint-wide
 * attempt-budget check, the generator edit-oscillation detector (directRepeat /
 * 3cycle triggers with the post-rejection guard, halting via the same
 * `LoopDetected` error with `reason: "editOscillation"`), their shared
 * `LoopDetected` error fields/factories and evidence types/validators, the
 * default seed ceiling table and seed budget, the user-facing halt-message
 * renderers, and the edit-set fingerprint function with its normalization-
 * parameter types. This is the only import surface other subsystems should
 * depend on. Pure re-exports — no runtime behaviour of its own.
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

export {
  fingerprintEditSet,
  type CommentSyntax,
  type SortableList,
  type FingerprintOptions,
  type EditFile,
  type EditSet,
} from './fingerprint.js';

export {
  OSCILLATION_ROLE,
  detectEditOscillation,
  isEditOscillationEvidence,
  renderEditOscillationMessage,
  createEditOscillationError,
  type DetectedPattern,
  type AttemptFingerprint,
  type FingerprintHistory,
  type EditOscillationEvidence,
} from './oscillation.js';
