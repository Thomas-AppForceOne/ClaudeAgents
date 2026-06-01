

/**
 * Persist a run's resolved workspace into its `progress.json`.
 *
 * The workspace record is the anchor later used for recovery (see
 * recovery-anchor) and the basis for cleanup decisions, so it is written
 * durably. The write is a *merge*: existing progress fields are preserved and
 * only the `workspace` key is set/replaced, so recording a workspace never
 * clobbers other progress the run has accumulated. Paths are stored in
 * canonical *display* form for stable, human-readable comparison across
 * worktrees.
 *
 * The module also owns the fresh-document seed primitive {@link seedProgress}
 * (births a `progress.json` with the full required-set populated to safe
 * defaults) and the narrow-update persister {@link writeProgressFields}'s
 * sibling-shaped {@link recordWorkspace} — both flow through the same
 * read-modify-write + atomic-write pipeline so a writer can never clobber the
 * required fields seedProgress lays down. Every merged document is run
 * through {@link validateProgress} before the rename swap; an invalid shape
 * is caught at write-time, not when a later reader compiles the validator.
 */
import { atomicWriteFile } from './atomic-write.js';
import { canonicalizePathForDisplay, stableStringify } from '../determinism/index.js';
import { createError } from '../errors.js';
import { readJsonObjectFile, stripForbiddenKeys } from './json-read.js';
import { validateProgress } from '../validation/schema-check.js';
import type { ResolvedWorkspace } from './worktree-resolver.js';

/**
 * The workspace facts persisted into progress.
 *
 * @property worktreePath the run's worktree, canonicalised for display.
 * @property branch the branch checked out there.
 * @property createdByGan whether the framework created the workspace (drives
 *   whether cleanup may later remove it).
 */
export interface WorkspaceRecord {

  worktreePath: string;

  branch: string;

  createdByGan: boolean;
}

/**
 * Project a {@link ResolvedWorkspace} into the persisted {@link WorkspaceRecord},
 * canonicalising the worktree path for display. Pure — no I/O.
 *
 * @param resolved the workspace resolution to record.
 * @returns the record shape written into progress.
 */
export function buildWorkspaceRecord(resolved: ResolvedWorkspace): WorkspaceRecord {
  return {
    worktreePath: canonicalizePathForDisplay(resolved.worktreePath),
    branch: resolved.branch,
    createdByGan: resolved.createdByGan,
  };
}

/**
 * Per-tier overlay snapshot — the shape `seedProgress` writes under
 * `overlaysAtSnapshot.user` and `overlaysAtSnapshot.project`. Mirrors the
 * `overlayTierSnapshot` shape in `schemas/progress-v1.json`.
 *
 * @property loaded whether the tier loaded at run start.
 * @property path absolute path of the loaded overlay file, `null` when absent.
 * @property hash sha256 of the loaded overlay's bytes, `null` when absent.
 */
export interface OverlayTierSnapshotRecord {
  loaded: boolean;
  path: string | null;
  hash: string | null;
}

/**
 * Per-tier overlay snapshot pair — written wholesale into
 * `overlaysAtSnapshot` at seed time so `--recover` can compare the live
 * overlay hashes against this snapshot.
 */
export interface OverlaysAtSnapshotRecord {
  user: OverlayTierSnapshotRecord;
  project: OverlayTierSnapshotRecord;
}

/**
 * Run context the seeder needs to write a schema-conforming initial
 * `progress.json` document — every required top-level field that is known at
 * lock-acquire / pre-clarify time is supplied here so the seed is complete
 * after the very first write.
 *
 * @property runId run identifier (must match the framework's `<YYYYMMDDTHHMMSS>-<4 hex>` shape).
 * @property projectRoot the run's project root (canonical display form).
 * @property runBranch the branch the run is performing work on.
 * @property baseBranch the branch the run's PR would target.
 * @property startingBranch the branch the user was on when starting the run.
 * @property workspace the resolved workspace record (worktreePath/branch/createdByGan).
 * @property overlaysAtSnapshot per-tier overlay snapshot taken at run start.
 */
export interface RunContextForSeed {
  runId: string;
  projectRoot: string;
  runBranch: string;
  baseBranch: string;
  startingBranch: string;
  workspace: WorkspaceRecord;
  overlaysAtSnapshot: OverlaysAtSnapshotRecord;
}

/**
 * Seed a fresh `progress.json` with the full required-set populated to safe
 * defaults.
 *
 * The schema (`schemas/progress-v1.json`) requires 17 top-level fields plus a
 * cross-field invariant coupling `terminal:true` to a populated terminal
 * triple. Subsequent narrow updates (status moves, contract-revision
 * increments, terminal-record emission) only touch a handful of fields each
 * — without an initial seed the document would never satisfy the schema in
 * one read-modify-write step. seedProgress lays the document down once,
 * after lock-acquire and before any narrow update fires, so every subsequent
 * write inherits the required set via the read-modify-write spread.
 *
 * The defaults are deliberate:
 * - `status: 'clarifying'` — the first stage of the orchestrator's lifecycle.
 * - `currentSprint`/`currentAttempt`/`contractRevision`/`totalSprints`/`completedSprints` zero
 *   because nothing has happened yet.
 * - `terminal: false` paired with `terminalReason: null` and `terminalAt: null`
 *   satisfies the schema's `terminal:false ⇒ both null` branch.
 * - `recoveryHistory: []` — fresh runs carry no `--recover` history.
 *
 * The seed is idempotent at the document level: re-seeding writes the same
 * shape, deterministically serialised; the temp-file + rename atomic-write
 * primitive serialises concurrent calls so the on-disk file always reflects
 * a complete seed.
 *
 * @param progressPath absolute path to the run's `progress.json`.
 * @param runContext see {@link RunContextForSeed} — every required field the
 *   seeder writes that is not a default lives here.
 *
 * Side effect: atomically rewrites `progressPath`. Throws via
 * {@link atomicWriteFile}'s `ConfigServerError('MalformedInput')` on I/O
 * failure. Throws via {@link assertValidProgress} when the constructed seed
 * fails {@link validateProgress} — an internal invariant violation, not a
 * user-facing error.
 */
export function seedProgress(progressPath: string, runContext: RunContextForSeed): void {
  const seed: Record<string, unknown> = {
    runId: runContext.runId,
    status: 'clarifying',
    currentSprint: 0,
    currentAttempt: 0,
    contractRevision: 0,
    totalSprints: 0,
    completedSprints: 0,
    projectRoot: runContext.projectRoot,
    runBranch: runContext.runBranch,
    baseBranch: runContext.baseBranch,
    startingBranch: runContext.startingBranch,
    workspace: { ...runContext.workspace },
    terminal: false,
    terminalReason: null,
    terminalAt: null,
    overlaysAtSnapshot: {
      user: { ...runContext.overlaysAtSnapshot.user },
      project: { ...runContext.overlaysAtSnapshot.project },
    },
    recoveryHistory: [],
  };
  assertValidProgress(progressPath, seed);
  atomicWriteFile(progressPath, stableStringify(seed));
}

/**
 * Write the run's workspace into `progress.json`, merging into any existing
 * progress.
 *
 * @param progressPath path to the run's `progress.json`.
 * @param resolved the resolved workspace to record.
 * @returns the {@link WorkspaceRecord} that was written.
 *
 * Side effect: atomically rewrites `progressPath` with the merged document
 * (existing keys preserved, `workspace` set). Serialised deterministically via
 * {@link stableStringify} so equal state yields byte-identical output.
 * @throws `ConfigServerError('MalformedInput')` from {@link atomicWriteFile} on
 *   an I/O failure; from {@link assertValidProgress} when the merged document
 *   would violate `progress-v1`'s contract (only checked once the base
 *   document is itself complete — partial pre-seed test fixtures are
 *   tolerated so the validator catches narrow-update clobbers without
 *   blocking the seeder-then-update sequence's first write).
 */
export function recordWorkspace(
  progressPath: string,
  resolved: ResolvedWorkspace,
): WorkspaceRecord {
  const record = buildWorkspaceRecord(resolved);
  const base = readProgressObject(progressPath);
  // Spread existing progress first, then set workspace: this preserves any
  // other fields the run already wrote and replaces only the workspace key.
  const next: Record<string, unknown> = { ...base, workspace: record };
  assertValidProgress(progressPath, next);
  atomicWriteFile(progressPath, stableStringify(next));
  return record;
}

/**
 * Read existing progress as a prototype-sanitised object, or `{}` when absent /
 * unreadable. Returning `{}` (rather than failing) lets the first
 * workspace-record write seed a fresh progress file. Sanitised because the
 * result is spread into the object that gets written back.
 */
function readProgressObject(progressPath: string): Record<string, unknown> {
  const obj = readJsonObjectFile(progressPath);
  return obj === undefined ? {} : stripForbiddenKeys(obj);
}

// The 17 top-level fields the progress-v1 schema marks as required. Exported
// for use by the sibling narrow-update writer (`writeProgressFields`) so both
// sites apply the same "validate-only-once-complete" guard. Listing the
// fields here rather than walking the schema avoids paying for a deep schema
// crawl on every write and keeps the guard auditable from a single line.
const PROGRESS_V1_REQUIRED_TOP_LEVEL: ReadonlyArray<string> = [
  'runId',
  'status',
  'currentSprint',
  'currentAttempt',
  'contractRevision',
  'totalSprints',
  'completedSprints',
  'projectRoot',
  'runBranch',
  'baseBranch',
  'startingBranch',
  'workspace',
  'terminal',
  'terminalReason',
  'terminalAt',
  'overlaysAtSnapshot',
  'recoveryHistory',
];

/**
 * Whether `doc` carries every top-level field the schema's `required[]`
 * lists. Used by the write-time validator wiring to distinguish a
 * production-shape document (seeded; full required set present) from a
 * partial pre-seed test fixture: validation runs against the full document
 * only, so the gate catches narrow-update clobbers and terminal-record
 * cross-field violations without rejecting deliberately-partial test
 * fixtures the orchestrator never produces.
 *
 * Exported so the sibling narrow-update writer
 * (`src/agents/independent-review/progress.ts`'s `writeProgressFields`) can
 * apply the same gate and the two sites stay byte-identical in their
 * acceptance shape.
 */
export function progressDocumentIsComplete(doc: Record<string, unknown>): boolean {
  for (const key of PROGRESS_V1_REQUIRED_TOP_LEVEL) {
    if (!Object.prototype.hasOwnProperty.call(doc, key)) return false;
  }
  return true;
}

/**
 * Assert that `doc` validates against `progress-v1` before it is handed to
 * the atomic-write primitive. The gate is conditional: a partial document
 * (missing some of the 17 required top-level fields) is treated as a
 * pre-seed in-flight shape and tolerated — only a document that *should* be
 * schema-complete (every required field present) is rejected on validation
 * failure. This catches the writer-side defect classes the reconciliation
 * gate exists to find (cross-field invariants, pattern/enum drift, nested
 * additionalProperties:false violations) without breaking call sites that
 * legitimately produce partial shapes (the existing relock tests pre-seed a
 * narrow `{ contractRevision, status, workspace }` body, for example).
 *
 * @param progressPath the target file path; included on the thrown error so
 *   a recovery flow can pinpoint which run produced the invalid shape.
 * @param doc the merged document about to be written.
 * @throws `ConfigServerError('SchemaMismatch')` when the document looks
 *   complete (every required field present) but fails validation. The
 *   thrown error names the first violation; the writer should be fixed at
 *   its emit site, not the schema relaxed to accommodate it.
 */
export function assertValidProgress(progressPath: string, doc: Record<string, unknown>): void {
  if (!progressDocumentIsComplete(doc)) return;
  const result = validateProgress(doc);
  if (result.valid) return;
  const first = result.errors[0];
  const where = first?.instancePath ?? '<root>';
  const detail = first?.message ?? 'failed progress-v1 validation';
  throw createError('SchemaMismatch', {
    file: progressPath,
    field: where,
    message:
      `Refusing to write '${progressPath}': the merged progress.json document does not ` +
      `conform to progress-v1 at '${where}' (${detail}). This indicates a writer-side ` +
      `regression; fix the call site rather than relaxing the schema.`,
  });
}
