/**
 * Top-level public API barrel for the ClaudeAgents framework package.
 *
 * This is the single module external consumers import from; it aggregates the
 * stable surface of every internal subsystem — the config-server API version,
 * the read/write/validate config tools, the run-store and worktree resolution
 * layer, run locking and recovery, run enumeration and cleanup planning, the
 * trace subsystem, and the shared result/config types. Everything re-exported
 * here is intended public API; anything reachable only by deep import is
 * internal and may change. Pure re-exports — this file holds no logic of its
 * own, so the grouping below mirrors the subsystem boundaries.
 */

export { getApiVersion } from './config-server/index.js';

export {
  getActiveStacks,
  getMergedSplicePoints,
  getModuleState,
  getOverlay,
  getResolvedConfig,
  getStack,
  getStackResolution,
  getTrustDiff,
  getTrustState,
  listModules,
  trustList,
} from './config-server/tools/reads.js';

export {
  appendToModuleState,
  appendToOverlayField,
  appendToStackField,
  registerModule,
  removeFromModuleState,
  removeFromOverlayField,
  removeFromStackField,
  setModuleState,
  setOverlayField,
  trustApprove,
  trustRevoke,
  updateStackField,
} from './config-server/tools/writes.js';

export { validateAll, validateOverlay, validateStack } from './config-server/tools/validate.js';

export {
  resolveStoreRoot,
  resolveMainWorktreeRoot,
  computeRepoKey,
  resolveRepoKey,
  resolveRepoStoreDir,
  resolveRunLockPath,
  resolveRunsRoot,
  resolveRunDir,
  resolveRunStore,
  generateRunId,
  DEFAULT_STORE_DIRNAME,
  STORE_MARKER_RELPATH,
  STORE_ROOT_ENV,
  REPO_KEY_HASH_LENGTH,
  RUN_ID_PATTERN,
  REPO_KEY_HASH_TAIL,
} from './config-server/storage/run-store.js';

export type { StoreEnv, ResolvedRunStore } from './config-server/storage/run-store.js';

export {
  slugify,
  terminalSlug,
  branchMatchesSlug,
  resolveDefaultBranch,
  resolveWorkspace,
  defaultGitExec,
} from './config-server/storage/worktree-resolver.js';

export type {
  GitExec,
  ResolvedWorkspace,
  ResolveWorkspaceOptions,
} from './config-server/storage/worktree-resolver.js';

export {
  buildWorkspaceRecord,
  recordWorkspace,
  seedProgress,
  assertValidProgress,
  progressDocumentIsComplete,
} from './config-server/storage/run-progress.js';

export type {
  WorkspaceRecord,
  RunContextForSeed,
  OverlayTierSnapshotRecord,
  OverlaysAtSnapshotRecord,
} from './config-server/storage/run-progress.js';

export {
  acquireRunLock,
  releaseRunLock,
  releaseRunLockAtPath,
  readRunLock,
  defaultIsAlive,
} from './config-server/storage/run-lock.js';

export type {
  RunLockContents,
  RunLockHandle,
  AcquireRunLockOptions,
  IsAlive,
} from './config-server/storage/run-lock.js';

export { checkRecoveryAnchor } from './config-server/storage/recovery-anchor.js';

export type {
  WorkspaceAnchor,
  RecoveryAnchorResult,
  CheckRecoveryAnchorOptions,
} from './config-server/storage/recovery-anchor.js';

export { enumerateRuns, findRun } from './config-server/storage/run-enumerator.js';

export type {
  EnumeratedRun,
  EnumeratedWorkspace,
} from './config-server/storage/run-enumerator.js';

export {
  planRunCleanup,
  executeRunCleanup,
  resolveMergeBase,
  isBranchMerged,
  checkActiveRunGuard,
  defaultRmDir,
} from './config-server/storage/cleanup-planner.js';

export type {
  BranchPlan,
  RunCleanupPlan,
  RunCleanupOutcome,
  CleanupOptions,
  ExecuteCleanupOptions,
  ActiveRunGuardResult,
  RmDir,
} from './config-server/storage/cleanup-planner.js';

export {
  TraceEmitter,
  computePromptRef,
  computeInputDigest,
  sha256Hex,
  isSha256Hex,
  buildPayloadFilename,
  buildPayloadRef,
  scanEvents,
  buildIndex,
  reconcileIndex,
  isUnrecoverable,
  safeMergeParsedObject,
  eventsDir,
  payloadsDir,
  indexPath,

  reconstructRecoveryState,
  reconstructRevisionState,
  nextRecoverySequence,
  buildTrustEventBody,
  buildValidationAbortBody,
  buildValidationAbortFromCode,
  buildLoopDetectedBody,
  formatHeartbeat,
  formatLlmCallSummary,
  formatWallclock,
  aggregateSprintSummary,
  formatSprintSummary,
  formatSprintSummaryFromEvents,
  verifyEvidenceBundle,
  checkFailCompleteness,
} from './trace/index.js';

export type {
  TraceEmitterOptions,
  RedactionMode,
  LlmRequestIdentity,
  TraceEvent,
  TraceIndex,
  PayloadClass,

  RecoveryState,
  RevisionState,
  RoleAttemptState,
  TrustResolution,
  TrustEventBody,
  ValidationAbortBody,
  SafetyHaltBody,
  LoopDetectionHalt,
  ValidationStage,
  F2ErrorLike,
  LlmCallMetrics,
  SprintSummaryAggregate,
  EvidenceBundleVerifyResult,
  EvidenceBundleFailure,
  EvidenceBundleCheck,
  ContractCriterionLike,
  BundleCriterion,
  IndependentReviewEvent,
} from './trace/index.js';

// The full safety surface. `src/safety/index.js` is the subsystem barrel and
// the canonical import surface; this package entry re-exports it in full so a
// consumer importing from the package root sees the same safety API the barrel
// exposes (per-role ceiling, sprint-wide budget, edit fingerprint + oscillation,
// the effective-config resolver, and the recovery pieces) — not just one slice.
export {
  // loop-detection (per-role ceiling)
  DEFAULT_ATTEMPT_CEILINGS,
  checkRoleCeiling,
  buildRoleCeilingEvidence,
  isRoleCeilingEvidence,
  isRoleCeilingEvidenceEntry,
  renderRoleCeilingMessage,
  createLoopDetectedError,
  // sprint-budget (aggregate ceiling)
  DEFAULT_SPRINT_BUDGET,
  SPRINT_ROLE,
  checkSprintBudget,
  buildSprintBudgetEvidence,
  isSprintBudgetEvidence,
  renderSprintBudgetMessage,
  createSprintBudgetError,
  // fingerprint (edit-set normalization)
  fingerprintEditSet,
  // oscillation (directRepeat / 3cycle)
  OSCILLATION_ROLE,
  detectEditOscillation,
  isEditOscillationEvidence,
  renderEditOscillationMessage,
  createEditOscillationError,
  // effective-safety-config resolver
  DEFAULT_RENEGOTIATION_CAP,
  MAX_ATTEMPTS_BUDGET_HEADROOM,
  resolveEffectiveSafetyConfig,
  readSafetyOverlayBlock,
  // recovery (--reset-attempts validation, terminal record, counter resume)
  FAILED_LOOP_DETECTED_TERMINAL_REASON,
  validateResetAttemptsUsage,
  buildLoopHaltTerminalRecord,
  effectiveStartingCounters,
} from './safety/index.js';

export type {
  // loop-detection
  LoopDetectedReason,
  LoopDetectedFields,
  RoleCeilingEvidenceEntry,
  CeilingDecision,
  CheckRoleCeilingInput,
  // sprint-budget
  SprintBudgetEvidence,
  CheckSprintBudgetInput,
  // fingerprint
  CommentSyntax,
  SortableList,
  FingerprintOptions,
  EditFile,
  EditSet,
  // oscillation
  DetectedPattern,
  AttemptFingerprint,
  FingerprintHistory,
  EditOscillationEvidence,
  // effective-safety-config resolver
  EffectiveSafetyConfig,
  SafetyRuntimeFlags,
  SafetyOverlayBlock,
  ResolveEffectiveSafetyConfigInput,
  // recovery
  ResetAttemptsValidation,
  ResetAttemptsFlags,
  LoopHaltTerminalRecord,
  EffectiveStartingCountersInput,
} from './safety/index.js';

// Independent-review subsystem: the typed bundle model, the pure
// reproduction-gate function, and the atomic re-lock helper that brackets
// a renegotiation round (archive-then-swap on the canonical contract,
// status-transition discipline on progress.json). Only the public surface
// is re-exported here; internal helpers stay file-local in
// src/agents/independent-review.
export {
  archivedContractPath,
  buildDraftPath,
  buildFailedEvaluationRejectedRecord,
  canonicalContractPath,
  FAILED_EVALUATION_REJECTED_TERMINAL_REASON,
  relockContract,
  validateFindings,
  writeProgressFields,
} from './agents/independent-review/index.js';
export type {
  BuildFailedEvaluationRejectedOptions,
  BuildFailedEvaluationRejectedResult,
  CommandFinding,
  CommandRunner,
  CommandRunnerResult,
  DropReason,
  DroppedFindingRecord,
  FailedEvaluationRejectedRecord,
  Finding,
  FindingKind,
  IndependentReviewBundle,
  InspectionFinding,
  RelockContractOptions,
  RelockContractResult,
  ReviewSummary,
  Severity,
  UnresolvedBlockerLike,
  ValidateFindingsResult,
} from './agents/independent-review/index.js';

export type { Issue } from './config-server/validation/schema-check.js';
export type { Warning, WarningCode, WarningDetails } from './config-server/warnings.js';
export type {
  ResolvedConfig,
  ResolvedStackEntry,
  AdditionalContextRow,
} from './config-server/resolution/resolved-config.js';
export type { OverlayTier } from './config-server/storage/overlay-loader.js';
export type { StackTier, StackResolution } from './config-server/resolution/stack-resolution.js';
export type { WriteResult } from './config-server/tools/writes.js';
