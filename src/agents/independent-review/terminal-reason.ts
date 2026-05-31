/**
 * Terminal-reason writer for a renegotiation round that failed at the cap
 * with unresolved blocking findings.
 *
 * When the renegotiation cap fires while at least one `blocker`-severity
 * finding remains unresolved, the run terminates as an evaluation failure:
 * the framework's gate said no, the work was not accepted. This is
 * semantically distinct from the loop-detection halts shipped under the
 * `LoopDetected` umbrella (`failed-loop-detected`), which signal genuine
 * non-convergence detected by the per-role ceiling, the sprint-wide budget,
 * or the edit-oscillation detector. Treating a cap-with-blockers exit as
 * "the gate rejected this work" rather than as thrash preserves the
 * distinction a user needs to act on it: a rejection is recoverable by
 * fixing the flagged defect; thrash recovery is about adjusting the prompt
 * or raising a ceiling.
 *
 * The helper writes `terminalReason: "failed-evaluation-rejected"` (literal
 * kebab-case, matching the recoverable-terminal-reason convention) and
 * `terminal: true` onto `progress.json` via the framework's atomic-write
 * primitive — the temp-file + rename dance, so a crash mid-write can never
 * leave a half-written terminal record on disk. The literal string is
 * frozen at the source: a divergent spelling (camelCase, a different word,
 * a typo) would make the terminated run undiscoverable to any downstream
 * consumer keyed on the exact value.
 *
 * Why this is a separate helper from `buildLoopHaltTerminalRecord` (which
 * builds the `failed-loop-detected` record): the two reasons gate on
 * different conditions and carry different semantics. Co-locating them
 * would couple unrelated decisions; a sibling helper keeps each call site
 * narrow ("the renegotiation cap fired with blockers" vs "a loop halt
 * fired") and lets a reader see which terminal class the writer is
 * recording without untangling shared branching.
 *
 * Why the helper is a no-op when `capFired` is false OR `unresolvedBlockers`
 * is empty: writing `terminal: true` is irreversible from the caller's
 * perspective — once the field lands on disk, `--recover` keys on it and
 * the run is considered terminated. A spurious write in either of these
 * cases would mark a non-terminal run as terminated. The helper therefore
 * defends both conditions with an explicit guard: a finished round with
 * zero blockers is a passing renegotiation, not a rejection, and a round
 * that has not yet reached the cap should not be terminated by the
 * renegotiation accounting at all.
 */

import { atomicWriteFile } from '../../config-server/storage/atomic-write.js';
import { stableStringify } from '../../config-server/determinism/index.js';
import {
  readJsonObjectFile,
  stripForbiddenKeys,
} from '../../config-server/storage/json-read.js';

/**
 * The kebab-case `terminalReason` literal a renegotiation-cap-with-blockers
 * rejection records on `progress.json`.
 *
 * **Why exactly this literal:** `terminalReason` codes are kebab-case ASCII
 * matching the existing recoverable-terminal convention shared with the
 * loop-detection record. A divergent spelling (camelCase, a different word,
 * a typo) would make the rejected run un-discoverable to any consumer
 * keyed on this exact value. Frozen at the source for the same reason
 * {@link FAILED_LOOP_DETECTED_TERMINAL_REASON} is frozen for its halt class.
 */
export const FAILED_EVALUATION_REJECTED_TERMINAL_REASON = 'failed-evaluation-rejected';

/**
 * Minimal shape of an unresolved blocking finding the helper inspects.
 *
 * The helper does not introspect any field beyond the array's length — it
 * only needs to know whether at least one blocker survived the round. A
 * loose `id` is named here so callers can pass their existing finding
 * records without reshaping them; additional fields are tolerated and
 * ignored. Defining the shape narrowly (rather than `unknown`) makes the
 * call-site contract self-documenting: a caller passing an unrelated array
 * gets a TS error rather than a silent acceptance.
 */
export interface UnresolvedBlockerLike {
  id: string;
  [key: string]: unknown;
}

/**
 * Inputs to {@link writeFailedEvaluationRejected}.
 *
 * @property progressFilePath absolute path to the run's `progress.json`. The
 *   helper read-modify-writes this file atomically; every field already on
 *   the document (workspace, telemetry markers, …) is preserved across the
 *   write — only `terminal` and `terminalReason` are added or replaced.
 * @property capFired `true` when the orchestrator decided the renegotiation
 *   cap has fired this sprint, `false` otherwise. The helper treats a
 *   `false` value as a no-op so a caller that wires the guard at the wrong
 *   site cannot accidentally mark a non-terminal run as terminated.
 * @property unresolvedBlockers the surviving `blocker`-severity findings at
 *   the moment the cap fired. The helper inspects only the length; an
 *   empty array (cap fired but every blocker was resolved) is treated as
 *   "the round actually passed, do not terminate" — a renegotiation that
 *   converges right at the cap is a pass, not a rejection.
 */
export interface WriteFailedEvaluationRejectedOptions {
  progressFilePath: string;
  capFired: boolean;
  unresolvedBlockers: ReadonlyArray<UnresolvedBlockerLike>;
}

/**
 * Result of {@link writeFailedEvaluationRejected}.
 *
 * @property written `true` when the helper wrote the terminal record,
 *   `false` when it short-circuited (cap not fired, or no unresolved
 *   blockers). A no-op write is reported explicitly so the caller can log
 *   it for the trace without having to re-derive the guard conditions.
 * @property terminalReason present only when `written` is `true`: the
 *   literal {@link FAILED_EVALUATION_REJECTED_TERMINAL_REASON} string.
 *   Returning the literal (rather than just `true`) gives the caller a
 *   single source of truth it can echo into a structured warning or test
 *   assertion without re-importing the constant.
 */
export interface WriteFailedEvaluationRejectedResult {
  written: boolean;
  terminalReason?: typeof FAILED_EVALUATION_REJECTED_TERMINAL_REASON;
}

/**
 * Write the `failed-evaluation-rejected` terminal record to `progress.json`
 * when, and only when, the renegotiation cap has fired with at least one
 * unresolved blocking finding.
 *
 * Behaviour:
 * - If `capFired === false` OR `unresolvedBlockers.length === 0`, the
 *   helper is a no-op: `progress.json` is not touched and the returned
 *   `written` is `false`. The two guards together protect against
 *   spuriously marking a non-terminal run terminated (see the module
 *   docblock for why a single guard is not enough).
 * - Otherwise the helper read-modify-writes `progress.json` atomically:
 *   reads the existing document (sanitised against prototype-pollution
 *   keys), spreads its current fields, layers `terminal: true` and
 *   `terminalReason: "failed-evaluation-rejected"` on top, serialises with
 *   the framework's deterministic stringifier, and writes via
 *   `atomicWriteFile` (temp-file + rename — never a half-written file).
 *
 * Why read-modify-write (not overwrite): `progress.json` is owned by the
 * orchestrator and accumulates fields across many subsystems (workspace,
 * telemetry, the renegotiation `contractRevision`, …). Overwriting would
 * clobber every unrelated field; the read-modify-write pattern mirrors
 * `relockContract` in this same subsystem so the two writers behave
 * consistently.
 *
 * @param opts see {@link WriteFailedEvaluationRejectedOptions}.
 * @returns a {@link WriteFailedEvaluationRejectedResult} describing whether
 *   the write fired. The `Promise` shape matches the orchestrator's other
 *   atomic-write call sites even though the underlying primitive is
 *   synchronous — keeping the surface uniform lets the caller `await` this
 *   without a branch.
 */
export async function writeFailedEvaluationRejected(
  opts: WriteFailedEvaluationRejectedOptions,
): Promise<WriteFailedEvaluationRejectedResult> {
  const { progressFilePath, capFired, unresolvedBlockers } = opts;

  // Guard 1: the cap has not fired. The renegotiation accounting only marks
  // a run terminal when the orchestrator has decided that further rounds
  // are not permitted; a not-yet-fired round must not be terminated by this
  // writer, even if blockers are present (they may still be resolved in a
  // later round under the cap).
  if (!capFired) {
    return { written: false };
  }

  // Guard 2: cap fired but zero blockers survived. A renegotiation that
  // converges right at the cap (every blocker resolved by the final round)
  // is a pass, not a rejection — the gate did not say no. Writing
  // `terminal: true` here would falsely terminate a passing run.
  if (unresolvedBlockers.length === 0) {
    return { written: false };
  }

  // Read-modify-write: preserve every existing field on progress.json. The
  // sanitiser strips the prototype-pollution-vector keys so a hostile field
  // smuggled into the file cannot pollute Object.prototype via the spread.
  const existing = readJsonObjectFile(progressFilePath);
  const base = existing === undefined ? {} : stripForbiddenKeys(existing);
  const next: Record<string, unknown> = {
    ...base,
    terminal: true,
    terminalReason: FAILED_EVALUATION_REJECTED_TERMINAL_REASON,
  };

  // atomicWriteFile is the single durable-write primitive every framework
  // writer funnels through — temp-file + rename, so a crash mid-write can
  // never leave a half-written terminal record on disk. Using it here
  // (rather than raw fs.writeFileSync) keeps this writer's crash-safety
  // story consistent with the rest of the codebase.
  atomicWriteFile(progressFilePath, stableStringify(next));

  return {
    written: true,
    terminalReason: FAILED_EVALUATION_REJECTED_TERMINAL_REASON,
  };
}
