/**
 * Public barrel for the `safety` subsystem — the framework-owned loop/thrash
 * detection layer (A1).
 *
 * Re-exports the pure per-role attempt-ceiling check, its `LoopDetected` error
 * fields/factory and evidence types/validators, the default seed ceiling table,
 * and the user-facing halt-message renderer. This is the only import surface
 * other subsystems should depend on. Pure re-exports — no runtime behaviour of
 * its own.
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
