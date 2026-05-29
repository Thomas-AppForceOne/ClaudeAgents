/**
 * Safety MCP tool handlers — six thin wrappers around the shipped safety
 * library. Three return halt decisions ({@link checkRoleCeilingTool},
 * {@link checkSprintBudgetTool}, {@link detectEditOscillationTool}); three
 * return constructed `LoopDetected` errors ({@link createLoopDetectedErrorTool},
 * {@link createSprintBudgetErrorTool}, {@link createEditOscillationErrorTool}).
 *
 * Every handler is a single-pass delegation to the imported library function —
 * the dual-callable-surface rule applies to every entry point in this module,
 * so a tool import and a direct `src/safety/*` import resolve to the same
 * underlying function. No second copy of the halt-decision logic and no second
 * copy of the error-builder logic lives behind these tools.
 *
 * Why preserve the library's object-argument signatures verbatim: the safety
 * library defines its inputs as object parameters with documented field names
 * (`role`, `attemptState`, `ceilings`, `evidence`, `attemptStateByRole`,
 * `budget`, `history`, …). Wrapping them in a re-shaped object would create a
 * second translation layer that the parity tests must then keep in sync; the
 * single-implementation rule is preserved by passing through unchanged.
 *
 * Why the error builders run through the library's already-wired
 * `createError('LoopDetected', …)` factory rather than a parallel factory: the
 * shipped error-factory rule requires every framework error flow through
 * `src/config-server/errors.ts`'s `createError`. The library builders already
 * comply; the wrappers therefore call them as-is and inherit the discipline.
 *
 * Why the `traceDir` argument is templated into the prose message rather than
 * hardcoded: the central-store run directory is substitutable per run, so the
 * caller (orchestrator) supplies the path and the library renderers interpolate
 * it. The wrappers never decide a path; they thread the caller's value through.
 */

import {
  checkRoleCeiling as libraryCheckRoleCeiling,
  checkSprintBudget as libraryCheckSprintBudget,
  detectEditOscillation as libraryDetectEditOscillation,
  createLoopDetectedError as libraryCreateLoopDetectedError,
  createSprintBudgetError as libraryCreateSprintBudgetError,
  createEditOscillationError as libraryCreateEditOscillationError,
  type CeilingDecision,
  type CheckRoleCeilingInput,
  type CheckSprintBudgetInput,
  type FingerprintHistory,
  type LoopDetectedFields,
} from '../../safety/index.js';
import type { ConfigServerError } from '../errors.js';

/**
 * Input to {@link checkRoleCeilingTool} — the library's
 * {@link CheckRoleCeilingInput} preserved exactly.
 *
 * @property role the kebab-case role id being checked.
 * @property attemptState the role's reconstructed attempt accounting (from the
 *   trace via `reconstructRecoveryState`), or `undefined` if the role has no
 *   attempts yet.
 * @property ceilings optional per-role ceiling table; defaults to the library's
 *   shipped seed table when omitted. Passed through unchanged so a caller
 *   overriding the table sees identical semantics to a direct library call.
 * @property evidence optional per-attempt evidence to attach when the halt
 *   fires; defaults to `[]` on the library side.
 */
export type CheckRoleCeilingToolInput = CheckRoleCeilingInput;

/**
 * Decide whether a single role has reached its per-role attempt ceiling.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryCheckRoleCeiling}. The argument object is passed through
 * unchanged so the wrapper neither inserts defaults nor reorders fields — the
 * library is the sole owner of those decisions.
 *
 * @param input the {@link CheckRoleCeilingToolInput}; the same object shape a
 *   direct library import would consume.
 * @returns the shipped {@link CeilingDecision} byte-for-byte; when halting,
 *   `fields.reason` is `'roleCeilingExceeded'`. Pure; never throws.
 */
export function checkRoleCeilingTool(input: CheckRoleCeilingToolInput): CeilingDecision {
  return libraryCheckRoleCeiling(input);
}

/**
 * Input to {@link checkSprintBudgetTool} — the library's
 * {@link CheckSprintBudgetInput} preserved exactly.
 *
 * @property attemptStateByRole the per-role attempt accounting reconstructed
 *   from the trace; the budget sums the `attemptCount` of every entry.
 * @property budget optional sprint-wide budget; defaults to the library's
 *   shipped seed budget when omitted. Passed through unchanged.
 */
export type CheckSprintBudgetToolInput = CheckSprintBudgetInput;

/**
 * Decide whether a sprint has reached its sprint-wide attempt budget.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryCheckSprintBudget}. The argument object is passed through
 * unchanged; in particular the wrapper does not coerce the `SPRINT_ROLE`
 * sentinel on the returned halting `fields.role` — the library is the sole
 * owner of that sentinel.
 *
 * @param input the {@link CheckSprintBudgetToolInput}.
 * @returns the shipped {@link CeilingDecision} byte-for-byte; when halting,
 *   `fields.reason` is `'sprintBudgetExceeded'` and `fields.role` is the
 *   `'sprint'` sentinel (distinct from the kebab-case agent role ids). Pure;
 *   never throws.
 */
export function checkSprintBudgetTool(input: CheckSprintBudgetToolInput): CeilingDecision {
  return libraryCheckSprintBudget(input);
}

/**
 * Input to {@link detectEditOscillationTool}.
 *
 * The library's `detectEditOscillation` takes the fingerprint history as a
 * positional first argument with an optional ceiling as the second. The tool
 * wraps both in an object — the MCP-tool convention — without altering the
 * underlying call.
 *
 * @property history the generator's per-attempt {@link FingerprintHistory},
 *   oldest first; each entry pairs the fingerprint with whether that attempt
 *   followed an evaluator rejection. Passed straight to the library.
 * @property oscillationDetection optional ceiling override threaded onto the
 *   halt's `fields.ceiling`. Mirrors the library's optional positional
 *   `ceiling` parameter (named here to match the safety overlay block's
 *   `oscillationDetection.ceiling` field on the resolved safety config).
 */
export interface DetectEditOscillationToolInput {
  history: FingerprintHistory;
  oscillationDetection?: number;
}

/**
 * Decide whether the generator's edit-fingerprint history shows oscillation.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryDetectEditOscillation}. Both the `directRepeat` trigger and
 * the `3cycle` trigger remain independent halt paths, and the post-rejection
 * guard that suppresses a repeat not following a rejection is preserved — the
 * wrapper does not collapse, reorder, or weaken those semantics.
 *
 * @param input the {@link DetectEditOscillationToolInput}; the wrapper unpacks
 *   `history` and the optional `oscillationDetection` ceiling and forwards
 *   both to the library positionals.
 * @returns the shipped {@link CeilingDecision} byte-for-byte; when halting,
 *   `fields.reason` is `'editOscillation'` and `fields.role` is the
 *   `OSCILLATION_ROLE` sentinel (`'gan-generator'`). Pure; never throws.
 */
export function detectEditOscillationTool(input: DetectEditOscillationToolInput): CeilingDecision {
  return libraryDetectEditOscillation(input.history, input.oscillationDetection);
}

/**
 * Input to {@link createLoopDetectedErrorTool}.
 *
 * @property fields the structured halt fields (typically from a halting
 *   {@link checkRoleCeilingTool} call). Passed through unchanged so the
 *   builder owns the discriminator (`reason: 'roleCeilingExceeded'`) and the
 *   five F2-style fields verbatim.
 * @property traceDir the run's trace directory; templated into the prose
 *   message by the library renderer. The wrapper never decides a path.
 */
export interface CreateLoopDetectedErrorToolInput {
  fields: LoopDetectedFields;
  traceDir: string;
}

/**
 * Construct the `LoopDetected` structured error for a per-role ceiling halt.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryCreateLoopDetectedError}, which already routes through the
 * shared `createError('LoopDetected', …)` factory. The returned error carries
 * `code: 'LoopDetected'`, the five halt-contract fields (`reason`, `role`,
 * `attempts`, `ceiling`, `evidence`) byte-equal to the input, and a `message`
 * produced by the shipped `renderRoleCeilingMessage` that names the role, the
 * attempt count, the ceiling, points at the run's trace directory (templated
 * from `traceDir`, not hardcoded), and instructs the user to re-run with
 * `--recover` after adjusting the prompt.
 *
 * @param input the {@link CreateLoopDetectedErrorToolInput}.
 * @returns the shipped {@link ConfigServerError}. Pure; never throws (it
 *   constructs, it does not raise).
 */
export function createLoopDetectedErrorTool(
  input: CreateLoopDetectedErrorToolInput,
): ConfigServerError {
  return libraryCreateLoopDetectedError(input.fields, input.traceDir);
}

/**
 * Input to {@link createSprintBudgetErrorTool}.
 *
 * @property fields the structured halt fields (typically from a halting
 *   {@link checkSprintBudgetTool} call). The `reason` discriminator
 *   (`sprintBudgetExceeded`), the `'sprint'` sentinel role, and the
 *   {@link SprintBudgetEvidence} object ride along verbatim.
 * @property traceDir the run's trace directory; templated into the prose
 *   message.
 */
export interface CreateSprintBudgetErrorToolInput {
  fields: LoopDetectedFields;
  traceDir: string;
}

/**
 * Construct the `LoopDetected` structured error for a sprint-wide budget halt.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryCreateSprintBudgetError}, which reuses the same
 * `createError('LoopDetected', …)` factory the per-role builder uses. Only
 * the discriminator (`sprintBudgetExceeded`), the `'sprint'` role, and the
 * evidence shape differ; the prose comes from `renderSprintBudgetMessage` —
 * it names the total attempt count, the budget, points at the trace directory,
 * and tells the user to re-run with `--recover`.
 *
 * @param input the {@link CreateSprintBudgetErrorToolInput}.
 * @returns the shipped {@link ConfigServerError}. Pure; never throws.
 */
export function createSprintBudgetErrorTool(
  input: CreateSprintBudgetErrorToolInput,
): ConfigServerError {
  return libraryCreateSprintBudgetError(input.fields, input.traceDir);
}

/**
 * Input to {@link createEditOscillationErrorTool}.
 *
 * @property fields the structured halt fields (typically from a halting
 *   {@link detectEditOscillationTool} call). The `reason` discriminator
 *   (`editOscillation`), the `'gan-generator'` sentinel role, and the
 *   {@link EditOscillationEvidence} object (carrying the detected `pattern`
 *   and the matched fingerprint sequence) ride along verbatim.
 * @property traceDir the run's trace directory; templated into the prose
 *   message.
 */
export interface CreateEditOscillationErrorToolInput {
  fields: LoopDetectedFields;
  traceDir: string;
}

/**
 * Construct the `LoopDetected` structured error for an edit-oscillation halt.
 *
 * Single-implementation: delegates directly to the shipped
 * {@link libraryCreateEditOscillationError}, which reuses the same
 * `createError('LoopDetected', …)` factory the per-role and budget builders
 * use. Only the discriminator (`editOscillation`), the `'gan-generator'`
 * role, and the evidence shape differ; the prose comes from
 * `renderEditOscillationMessage` — it names the detected pattern, the attempt
 * count, points at the trace directory, and tells the user to re-run with
 * `--recover`.
 *
 * @param input the {@link CreateEditOscillationErrorToolInput}.
 * @returns the shipped {@link ConfigServerError}. Pure; never throws.
 */
export function createEditOscillationErrorTool(
  input: CreateEditOscillationErrorToolInput,
): ConfigServerError {
  return libraryCreateEditOscillationError(input.fields, input.traceDir);
}
