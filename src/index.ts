

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

export { buildWorkspaceRecord, recordWorkspace } from './config-server/storage/run-progress.js';

export type { WorkspaceRecord } from './config-server/storage/run-progress.js';

export {
  acquireRunLock,
  releaseRunLock,
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
  nextRecoverySequence,
  buildTrustEventBody,
  buildValidationAbortBody,
  buildValidationAbortFromCode,
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
  RoleAttemptState,
  TrustResolution,
  TrustEventBody,
  ValidationAbortBody,
  ValidationStage,
  F2ErrorLike,
  LlmCallMetrics,
  SprintSummaryAggregate,
  EvidenceBundleVerifyResult,
  EvidenceBundleFailure,
  EvidenceBundleCheck,
  ContractCriterionLike,
  BundleCriterion,
} from './trace/index.js';

export type { Issue } from './config-server/validation/schema-check.js';
export type {
  ResolvedConfig,
  ResolvedStackEntry,
  AdditionalContextRow,
} from './config-server/resolution/resolved-config.js';
export type { OverlayTier } from './config-server/storage/overlay-loader.js';
export type { StackTier, StackResolution } from './config-server/resolution/stack-resolution.js';
export type { WriteResult } from './config-server/tools/writes.js';
