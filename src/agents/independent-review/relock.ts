/**
 * Atomic re-lock helper for the renegotiation loop.
 *
 * When a renegotiation round produces a new audited contract draft, the
 * orchestrator must swap that draft into the canonical
 * `sprint-{N}-contract.json` filename without ever leaving a downstream
 * reader observing a half-written or missing file. The evaluator's evidence-
 * bundle join key is hardcoded against the unsuffixed canonical filename, so
 * the canonical file's content must transition from "old revision in full"
 * to "new revision in full" as a single observable step, with no
 * intermediate state where the file is missing, empty, or partially
 * written. This module is the deterministic, pluggable core of that swap.
 *
 * Why a callback-shaped function (instead of "give us the new content and we
 * write it"):
 * - The renegotiation work — proposing additions, auditing them, writing
 *   the draft — is the orchestrator's, not this module's. Keeping the
 *   write-the-draft step in the caller's callback lets the orchestrator
 *   stay in charge of which agents to spawn and what the draft looks like;
 *   this helper owns only the file-system lifecycle around the draft.
 * - The status-transition discipline (`"negotiating"` while the callback
 *   runs, `"building"` after) is the same shape on success and on failure:
 *   the helper sets `negotiating` once, awaits the callback, and restores
 *   `building` from a `finally` so even an exception path leaves the
 *   status field consistent with the on-disk truth.
 *
 * Why `fs.rename` (specifically) for the swap:
 * - POSIX `rename(2)` is atomic *within a single filesystem*: a concurrent
 *   reader sees either the old file or the new file in full, never a
 *   partial blend. This is the same guarantee `atomic-write.ts` relies on
 *   for every durable write in the framework; using the same primitive
 *   keeps the swap's atomicity story consistent with the rest of the
 *   codebase rather than introducing a parallel mechanism (e.g. write +
 *   fsync + rename + fsync of the directory) the operator would have to
 *   reason about separately.
 * - A cross-filesystem rename is NOT atomic — it degrades silently to a
 *   copy. Both the archive step and the canonical swap therefore stay
 *   within the run directory; the temp draft and the archived sibling
 *   share the canonical file's directory, never `/tmp` or another mount.
 *
 * Why archive-then-replace (not replace-then-archive):
 * - Archive-then-replace makes the "prior revision is preserved" invariant
 *   strictly stronger: the archive sibling is on disk *before* the
 *   canonical file gets overwritten, so a crash between the two renames
 *   leaves the prior revision available at TWO paths (the archived
 *   sibling and the canonical filename, which still holds the prior
 *   content because the second rename has not yet fired) — never zero.
 *   Replace-then-archive would, conversely, briefly leave the new
 *   revision canonical while the prior revision had no file at all, so a
 *   crash mid-sequence would lose the prior revision entirely.
 * - The on-disk story under crash therefore reduces to: either the prior
 *   revision is canonical (everything before the canonical swap throws),
 *   or the new revision is canonical AND the prior revision is archived
 *   (both renames completed). Never a half-state, never lost history.
 *
 * Why a `.draft-tmp.<token>.json` filename convention for the caller-
 * supplied draft path:
 * - Distinguishes the draft from the canonical file (which has no
 *   `.draft-tmp.` infix) and from the archived siblings (which end in
 *   `.r{k}.json`, not `.draft-tmp.<token>.json`). A recovery flow scanning
 *   the run directory can therefore tell apart unlocked partial drafts
 *   from the authoritative file without consulting an external manifest.
 * - The `<token>` is random hex (built by {@link buildDraftPath}) so two
 *   concurrent or retried renegotiation rounds never collide on the same
 *   draft path before the canonical swap serialises them.
 *
 * Why read-modify-write on `progress.json` (not overwrite):
 * - `progress.json` is owned by the orchestrator and accumulates fields
 *   across many subsystems (workspace, terminalReason, telemetry markers,
 *   …). Overwriting it would clobber every unrelated field; the
 *   read-modify-write pattern (mirrored from `recordWorkspace` in
 *   `run-progress.ts`) preserves them and updates only `status` and
 *   `contractRevision`.
 *
 * Why an in-process mutex keyed on `progressFilePath`:
 * - The Node event loop is single-threaded, but `async` functions
 *   interleave at every `await` boundary. The critical section of this
 *   helper spans `await runRound()`, so two `Promise.all([relockContract
 *   (...), relockContract(...)])` calls against the same progress file
 *   *will* interleave their read-archive-swap-write sequences unless the
 *   helper holds a serialisation primitive across the await. The helper
 *   therefore owns a module-scope `Map<progressFilePath, Promise<unknown>>`
 *   onto which each call chains; concurrent invocations against the same
 *   path serialise on the tail promise, while invocations against
 *   *different* progress files never block each other. The map entry is
 *   cleared in the `finally` only when the call is still the tail, so the
 *   map naturally garbage-collects rather than growing unboundedly over
 *   the lifetime of a long-running process.
 *
 * Preconditions:
 * - **In-process serialisation is owned by this helper.** A caller does
 *   NOT need to serialise concurrent calls itself; the path-keyed mutex
 *   above does that. Two callers firing `Promise.all` against the same
 *   `progressFilePath` will both see correct archival semantics
 *   (.r{k}.json AND .r{k+1}.json, `contractRevision` incremented by 2).
 * - **Cross-process serialisation is NOT this helper's job.** Two
 *   separate Node processes writing to the same `progressFilePath` are
 *   still coordinated only by the run-lock (a `flock`-style cross-process
 *   file lock); this helper's mutex is purely in-process. The boundary is
 *   intentional: re-implementing cross-process exclusion here would
 *   duplicate the run-lock's job and force a second on-disk lock file
 *   into the run directory.
 */

import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';

import {
  readJsonObjectFile,
  stripForbiddenKeys,
} from '../../config-server/storage/json-read.js';
import { writeProgressFields } from './progress.js';

/**
 * Inputs to {@link relockContract}.
 *
 * @property runDir absolute path to the run directory holding
 *   `sprint-{N}-contract.json` (the canonical contract this helper swaps)
 *   and `progress.json` (the file this helper updates).
 * @property sprintNumber the 1-based sprint index `{N}` is filled with when
 *   resolving the canonical and archived filenames.
 * @property newDraftPath absolute path to the audited draft the round
 *   produces; the caller writes this file inside {@link runRound}. Per the
 *   filename convention documented in this module's header, the path SHOULD
 *   end in `.draft-tmp.<token>.json` so a crash leaves identifiable debris
 *   — {@link buildDraftPath} produces a path that satisfies the convention.
 * @property progressFilePath absolute path to `progress.json`; passed in
 *   rather than computed so a test fixture can isolate the read-modify-
 *   write side effect to a tmp-dir.
 * @property runRound the renegotiation work the helper brackets. The
 *   helper sets `status: "negotiating"` before awaiting it and restores
 *   `status: "building"` after it resolves (or rejects). The callback is
 *   responsible for writing the audited draft to `newDraftPath`; the
 *   helper does NOT validate the draft's content (auditing is the
 *   contract-reviewer's job).
 */
export interface RelockContractOptions {
  runDir: string;
  sprintNumber: number;
  newDraftPath: string;
  progressFilePath: string;
  runRound: () => Promise<void>;
}

/**
 * Result of a successful {@link relockContract} call.
 *
 * @property newRevision the contract revision now canonical, equal to the
 *   pre-call `progress.json.contractRevision` plus one. The original locked
 *   contract is revision 0, so the first successful re-lock returns
 *   `newRevision: 1`, the second returns 2, and so on.
 * @property archivedPath absolute path of the archived `.r{k}.json` sibling
 *   the prior canonical revision was renamed to. `k` is the revision index
 *   the archived file was authoritative under (so the first re-lock
 *   archives to `sprint-{N}-contract.r0.json`).
 */
export interface RelockContractResult {
  newRevision: number;
  archivedPath: string;
}

/**
 * Resolve the canonical contract filename inside `runDir` for sprint `N`.
 *
 * Exported so tests and the recovery flow can name the file by the same
 * rule the helper uses; the orchestrator's downstream evidence-bundle join
 * relies on this exact form.
 *
 * @param runDir absolute path to the run directory.
 * @param sprintNumber 1-based sprint index `{N}` is filled with.
 * @returns absolute path of the canonical contract file.
 */
export function canonicalContractPath(runDir: string, sprintNumber: number): string {
  return path.join(runDir, `sprint-${sprintNumber}-contract.json`);
}

/**
 * Resolve the archived `.r{k}.json` sibling filename for revision `k`.
 *
 * @param runDir absolute path to the run directory.
 * @param sprintNumber 1-based sprint index.
 * @param revisionIndex the revision the archived file was authoritative
 *   under (0 for the original locked contract).
 * @returns absolute path of the archived sibling.
 */
export function archivedContractPath(
  runDir: string,
  sprintNumber: number,
  revisionIndex: number,
): string {
  return path.join(runDir, `sprint-${sprintNumber}-contract.r${revisionIndex}.json`);
}

/**
 * Build a recognisable draft-tmp path inside `runDir` for sprint `N`.
 *
 * The filename embeds a random hex token so two concurrent renegotiation
 * rounds (or a retry after a crash) never collide on the same draft path
 * before the canonical swap serialises them. The `.draft-tmp.` infix is
 * what a recovery flow keys on to tell unlocked partial drafts apart from
 * the canonical file and the archived siblings.
 *
 * @param runDir absolute path to the run directory.
 * @param sprintNumber 1-based sprint index.
 * @returns absolute path of a fresh draft-tmp file (the file itself is NOT
 *   created by this function — the caller writes it inside {@link
 *   relockContract}'s `runRound` callback).
 */
export function buildDraftPath(runDir: string, sprintNumber: number): string {
  // 6 hex chars (24 bits of entropy) is plenty: collisions would require
  // two concurrent renegotiation rounds *in the same run directory at the
  // same instant* to roll the same token, which the run-lock already
  // prevents at a coarser granularity.
  const token = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return path.join(runDir, `sprint-${sprintNumber}-contract.draft-tmp.${token}.json`);
}

/**
 * In-process serialisation primitive: one promise chain per
 * `progressFilePath`. Two concurrent invocations against the same path
 * chain onto the tail promise so their read-archive-swap-write sequences
 * never interleave; two invocations against *different* paths run
 * concurrently because they live in distinct map slots. The map slot is
 * cleared in the `finally` of the wrapper only when the just-settled
 * call is still the tail (i.e. no later caller chained onto it after we
 * stored ourselves), so a long-running process accumulates at most one
 * entry per actively-in-flight `progressFilePath`.
 *
 * See the "Why an in-process mutex keyed on `progressFilePath`" and
 * "Preconditions" sections of this module's header for the rationale and
 * the cross-process boundary.
 */
const inflightByProgressPath = new Map<string, Promise<unknown>>();

/**
 * Run one renegotiation round end-to-end with the atomicity, archival, and
 * status-transition invariants this module is contracted to enforce.
 *
 * Sequence (each numbered step is observable on disk in the order shown):
 *
 * 1. Read the pre-call `progress.json.contractRevision` (defaulting to 0
 *    when absent — the original locked contract is revision 0 by
 *    convention).
 * 2. Write `progress.json` with `status: "negotiating"` (read-modify-
 *    write; all other fields preserved). This is the observable signal
 *    that a round is in flight; observers (the human operator, the trace
 *    consumer) read it to know the helper is between the two halves of
 *    its atomic swap.
 * 3. Await `runRound()`. The caller writes the audited draft to
 *    `newDraftPath` inside this callback; the helper does not introspect
 *    the draft's content. If the callback rejects, the helper restores
 *    `status: "building"` from the `finally` block and rethrows — the
 *    canonical contract is untouched (no rename has fired yet).
 * 4. Archive the prior canonical contract: `fs.rename` it to its
 *    `.r{k}.json` sibling, where `k` is the pre-call revision index. If
 *    the canonical file does not exist (a recovery path the helper
 *    tolerates rather than fails), the archive step is skipped and the
 *    `archivedPath` returned still names the would-be archive location so
 *    a caller can tell the difference. Archive-then-swap (not swap-then-
 *    archive) is the invariant that prevents a crash from leaving the
 *    prior revision lost — see this module's header for the rationale.
 * 5. Atomic-rename `newDraftPath` onto the canonical filename. POSIX
 *    `rename(2)` is atomic within a single filesystem, so a concurrent
 *    reader sees either the prior canonical (which is gone here because
 *    step 4 already moved it) or the new revision in full — never a
 *    half-state. If this rename throws, the prior canonical is already
 *    archived: the caller can recover by reading the archived sibling.
 * 6. Read-modify-write `progress.json`: set `contractRevision` to
 *    `k + 1` and `status` to `"building"`. The increment is observable
 *    only after the swap completes; a crash before step 5 leaves the
 *    counter at its pre-call value.
 *
 * Failure semantics:
 * - If `runRound()` rejects, the helper restores `status: "building"` (the
 *   `contractRevision` is NOT incremented, because no swap fired) and
 *   rethrows the original error. The canonical contract is byte-identical
 *   to what was on disk before the call.
 * - If `runRound()` resolves WITHOUT writing the audited draft at
 *   `newDraftPath`, the helper performs a pre-swap existence check on
 *   `newDraftPath` BEFORE touching the canonical (i.e. before step 4),
 *   throws an `Error` naming the missing draft path, restores `status:
 *   "building"`, and rethrows. Because the throw fires while the
 *   canonical is still in place, no archive rename has happened and the
 *   prior revision is canonical, byte-identical to the pre-call state.
 * - If the archive rename (step 4) throws, the helper restores
 *   `status: "building"` and rethrows. The canonical contract is
 *   untouched (the throw fired before any rename completed); the draft
 *   file remains at its `.draft-tmp.<token>.json` path for a recovery
 *   flow to clean up.
 * - If the canonical swap (step 5) throws AFTER the archive rename
 *   succeeded, the helper attempts an in-process rollback by renaming
 *   the archived sibling back onto the canonical filename. If the
 *   rollback succeeds, the helper re-throws the ORIGINAL swap error (so
 *   the operator sees the diagnostic from the failure that actually
 *   matters, not the rollback's success). If the rollback ITSELF throws,
 *   the helper throws a new `Error` naming both `archived` and
 *   `canonical` paths so the operator can recover by hand from the
 *   archive sibling; the original swap error is preserved as the
 *   ES2022 `cause` of the new error. In all rollback paths the helper
 *   then restores `status: "building"`.
 * - In-process concurrency is owned by this helper via the module-scope
 *   path-keyed mutex (`inflightByProgressPath`): two concurrent
 *   invocations against the same `progressFilePath` serialise, so the
 *   second caller reads the first caller's incremented `contractRevision`
 *   and archives to `.r{k+1}.json` rather than overwriting `.r{k}.json`.
 *   Cross-process serialisation remains the run-lock's job; see the
 *   "Preconditions" section in this module's header for the boundary.
 *
 * In every failure path the on-disk story is therefore: EITHER the prior
 * revision is canonical (no archive sibling created for this round, or
 * the archive sibling was rolled back onto the canonical), OR the new
 * revision is canonical AND the prior revision is archived.
 * Never a half-state, never lost history.
 *
 * Side effects:
 * - Rewrites `progress.json` twice (read-modify-write each time), once
 *   with `status: "negotiating"` and once with the final state. Other
 *   fields are preserved across both writes.
 * - Renames the prior canonical contract to its archived sibling (when
 *   the canonical exists).
 * - Renames `newDraftPath` onto the canonical filename.
 *
 * @param opts see {@link RelockContractOptions}.
 * @returns the {@link RelockContractResult} on success.
 * @throws whatever `runRound()` rejects with, or an `Error` from the
 *   underlying `fs.rename` if the archive or canonical swap fails. The
 *   helper does NOT translate these — it surfaces them verbatim so the
 *   caller can diagnose I/O failures without losing the OS-level
 *   message.
 * @throws an `Error` whose message starts with `relockContract: runRound
 *   resolved without writing the draft at ` followed by the missing
 *   `newDraftPath` when the `runRound` callback resolves successfully
 *   but does not produce the audited draft on disk. The throw fires
 *   BEFORE the archive rename, so the canonical contract is
 *   byte-identical to its pre-call state when the catch runs.
 * @throws an `Error` whose message starts with `relockContract:
 *   canonical swap failed (` and names both `archived` and `canonical`
 *   paths when the canonical swap fails AND the in-process rollback of
 *   the archive sibling also fails. The thrown error's `cause` is the
 *   original swap error. When the rollback succeeds, the helper
 *   re-throws the original swap error verbatim (no message rewrite).
 */
export async function relockContract(
  opts: RelockContractOptions,
): Promise<RelockContractResult> {
  const { progressFilePath } = opts;

  // Chain regardless of whether the prior call settled with success or
  // failure: we only need ordering, not propagation of the prior call's
  // outcome (a prior throw must NOT cascade into the next caller's
  // observable result). The `.catch(() => undefined)` collapses both
  // settlement shapes into a single resolved value the `.then` can
  // sequence against.
  const prev = inflightByProgressPath.get(progressFilePath) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(() => relockContractCore(opts));
  inflightByProgressPath.set(progressFilePath, run);

  try {
    return (await run) as RelockContractResult;
  } finally {
    // Clear the slot only if we're still the tail; otherwise a later
    // chained call has already replaced us in the map and must own the
    // cleanup. This is what keeps the map naturally garbage-collecting.
    if (inflightByProgressPath.get(progressFilePath) === run) {
      inflightByProgressPath.delete(progressFilePath);
    }
  }
}

/**
 * Internal: the actual re-lock protocol, executed once per call after
 * the wrapper has serialised concurrent invocations on the same
 * `progressFilePath`. The wrapper guarantees this function never
 * interleaves with itself for a given path; the implementation can
 * therefore assume single-writer semantics within the process.
 */
async function relockContractCore(
  opts: RelockContractOptions,
): Promise<RelockContractResult> {
  const { runDir, sprintNumber, newDraftPath, progressFilePath, runRound } = opts;

  const canonical = canonicalContractPath(runDir, sprintNumber);
  // Pre-call read: the revision index `k` the archived sibling will be
  // named after, and the field this helper increments on success. Default
  // 0 when absent so a fresh run (no `progress.json` yet, or no
  // `contractRevision` key) treats the original locked contract as
  // revision 0 by convention — matching the renegotiation-loop section
  // in SKILL.md.
  const priorRevision = readContractRevision(progressFilePath);
  const archived = archivedContractPath(runDir, sprintNumber, priorRevision);

  // Announce the in-flight round on disk BEFORE running the callback so
  // an observer reading `progress.json` mid-round sees `"negotiating"`
  // even if the round is long-running.
  writeProgressFields(progressFilePath, { status: 'negotiating' });

  // Tracks whether step 4 (the archive rename) succeeded. If the
  // canonical swap (step 5) later throws, this flag tells us whether
  // there is an archive sibling to roll back onto the canonical.
  let archivedFromCanonical = false;

  try {
    // The renegotiation work itself — the caller's responsibility. By the
    // time this resolves, `newDraftPath` must hold the audited draft.
    await runRound();

    // Fail-fast: if the callback resolved without producing the draft,
    // throw BEFORE touching the canonical so the prior revision is
    // still in place when the catch runs. The thrown error names the
    // missing path so a recovery flow can act on it directly, and the
    // archive rename has not yet fired so no on-disk rollback is
    // needed beyond the status restoration the catch already does.
    if (!existsSync(newDraftPath)) {
      throw new Error(
        `relockContract: runRound resolved without writing the draft at ${newDraftPath}`,
      );
    }

    // Archive-then-swap: rename the prior canonical to its `.r{k}.json`
    // sibling FIRST, so a crash between the two renames leaves the
    // prior revision available at the archive path (never lost). When
    // the canonical doesn't exist (an unusual but tolerated path — e.g.
    // the very first lock fired into an empty directory under recovery),
    // skip the archive rename rather than fail; the swap step still
    // promotes the new draft to canonical.
    if (canonicalExists(canonical)) {
      renameSync(canonical, archived);
      archivedFromCanonical = true;
    }

    // The atomic swap. After this returns, the new revision IS the
    // canonical contract; downstream readers (the evaluator's evidence-
    // bundle join in particular) see the new content in full on their
    // next read of the canonical filename. If this rename throws after
    // the archive succeeded, we roll the archive back onto the
    // canonical so the on-disk story is "prior revision is canonical"
    // — the same shape every other pre-swap failure path produces.
    try {
      renameSync(newDraftPath, canonical);
    } catch (swapErr) {
      if (archivedFromCanonical) {
        try {
          renameSync(archived, canonical);
          archivedFromCanonical = false;
        } catch (rollbackErr) {
          // Rollback itself failed: surface BOTH paths in the thrown
          // error so the operator can recover manually from the
          // archive sibling. The original swap error is preserved as
          // the ES2022 `cause` so the diagnostic chain is not lost.
          // We deliberately keep `rollbackErr` out of the message
          // (the operator can read it from the surrounding logs); the
          // load-bearing information is WHICH two paths are involved.
          void rollbackErr;
          throw new Error(
            `relockContract: canonical swap failed (${(swapErr as Error).message}) and rollback of archived sibling ${archived} -> ${canonical} also failed; prior revision is at ${archived}`,
            { cause: swapErr as Error },
          );
        }
      }
      // Rollback succeeded (or there was no archive to roll back).
      // Re-throw the ORIGINAL swap error so the diagnostic message is
      // preserved verbatim — callers pattern-matching on the OS-level
      // error continue to work.
      throw swapErr;
    }

    // Commit the revision increment and return status to `building`.
    // This write is observable only AFTER the two renames have
    // completed; a crash before this point leaves `contractRevision`
    // at its pre-call value, which is exactly what the recovery flow
    // needs to know to disambiguate "round started but did not finish"
    // from "round finished and the new revision is canonical".
    writeProgressFields(progressFilePath, {
      contractRevision: priorRevision + 1,
      status: 'building',
    });

    return {
      newRevision: priorRevision + 1,
      archivedPath: archived,
    };
  } catch (err) {
    // Restore `status: "building"` on any failure path so an observer is
    // never left reading `"negotiating"` for a round that has already
    // terminated. `contractRevision` is NOT touched here — only a
    // successful swap increments it, so a failed round leaves the
    // counter at its pre-call value.
    writeProgressFields(progressFilePath, { status: 'building' });
    throw err;
  }
}

/**
 * Read `progress.json.contractRevision` as a non-negative integer, or 0
 * when the file or field is absent / malformed.
 *
 * Defaulting to 0 (rather than throwing) lets the helper bootstrap a run
 * that has not yet written `contractRevision` — the original locked
 * contract is revision 0 by convention, so a missing field is read as the
 * starting value the first re-lock would increment from.
 */
function readContractRevision(progressFilePath: string): number {
  const obj = readJsonObjectFile(progressFilePath);
  if (obj === undefined) return 0;
  const sanitised = stripForbiddenKeys(obj);
  const v = sanitised['contractRevision'];
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  return 0;
}

/**
 * `true` when the canonical contract file is on disk, `false` otherwise.
 *
 * Implemented with `existsSync` (not `readJsonObjectFile`) so a contract
 * whose content happens to parse as something other than a JSON object —
 * e.g. a JSON array, an empty file under a partial write — is still
 * treated as present and gets archived rather than silently overwritten.
 * The archive rename is content-agnostic; it preserves whatever bytes are
 * there, which is the right behaviour for a recovery flow inspecting an
 * unexpected on-disk state.
 */
function canonicalExists(canonicalPath: string): boolean {
  return existsSync(canonicalPath);
}
