/**
 * Barrel for the independent-review subsystem.
 *
 * Re-exports the public surface — the typed bundle model and the pure
 * reproduction-gate function — so consumers can import everything they
 * need from one path (`src/agents/independent-review`) without reaching
 * into individual files. Internal helpers stay file-local.
 */

export type {
  CommandFinding,
  CommandRunner,
  CommandRunnerResult,
  DropReason,
  DroppedFindingRecord,
  Finding,
  FindingKind,
  IndependentReviewBundle,
  InspectionFinding,
  ReviewSummary,
  Severity,
  ValidateFindingsResult,
} from './types.js';

export { validateFindings } from './finding-validation.js';
