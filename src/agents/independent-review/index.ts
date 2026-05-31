/**
 * Barrel for the independent-review subsystem.
 *
 * Re-exports the public surface — the typed bundle model, the pure
 * reproduction-gate function, the atomic re-lock helper, and the terminal-
 * reason record builder — so consumers can import everything they need from
 * one path (`src/agents/independent-review`) without reaching into
 * individual files. Internal helpers stay file-local.
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

// Terminal-reason record builder for the renegotiation cap-with-blockers
// rejection: returns the `terminal: true` + `terminalReason:
// "failed-evaluation-rejected"` fields when, and only when, the cap fires
// with at least one unresolved blocker. Symmetric with
// `buildLoopHaltTerminalRecord` in `src/safety/recovery.ts`. Persistence is
// the caller's responsibility — the MCP wrapper in
// `src/config-server/tools/independent-review.ts` composes builder +
// shared persister; a TS caller invokes `writeProgressFields` on the
// returned record directly.
export {
  buildFailedEvaluationRejectedRecord,
  FAILED_EVALUATION_REJECTED_TERMINAL_REASON,
} from './terminal-reason.js';
export type {
  BuildFailedEvaluationRejectedOptions,
  BuildFailedEvaluationRejectedResult,
  FailedEvaluationRejectedRecord,
  UnresolvedBlockerLike,
} from './terminal-reason.js';

// Shared progress.json read-modify-write helper. Both `relock.ts` and the
// caller-side persistence step for `buildFailedEvaluationRejectedRecord`
// consume this primitive; exporting it from the barrel lets a TS caller
// pair the builder with the persister without reaching into the file-
// local module.
export { writeProgressFields } from './progress.js';
