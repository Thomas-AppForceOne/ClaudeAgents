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

// Atomic re-lock helper for the renegotiation loop: brackets a renegotiation
// round between status transitions, archives the prior canonical contract to
// its `.r{k}.json` sibling, and atomic-renames the audited draft onto the
// canonical filename. The helper's atomicity, archive-then-swap discipline,
// and progress.json read-modify-write are documented in relock.ts's header.
export {
  archivedContractPath,
  buildDraftPath,
  canonicalContractPath,
  relockContract,
} from './relock.js';
export type { RelockContractOptions, RelockContractResult } from './relock.js';
