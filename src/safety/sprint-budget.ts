/**
 * Sprint-wide attempt budget — the framework-owned aggregate-ceiling halt
 * primitive that composes with the per-role ceiling check in
 * `./loop-detection.ts`.
 *
 * Where {@link checkRoleCeiling} caps how many times a *single* role may attempt
 * its step, this module caps the *combined* work across the whole sprint: the
 * summed attempt count over every role, including the single-attempt roles
 * (clarifier, planner) that carry no per-role ceiling. This catches pathological
 * cross-role thrash — a sprint that cycles plan → contract → generate → evaluate
 * → revise indefinitely while no single role ever reaches its own ceiling.
 *
 * Like the per-role check, every export here is pure: a function over a plain
 * per-role attempt tally (the `attemptStateByRole` map `reconstructRecoveryState`
 * derives from `agentAttempt` events) plus the budget. There is no I/O and no
 * persisted running sum — the trace stays the single source of truth for "how
 * many attempts have happened" so `--recover` can rebuild the count from the
 * event log alone (a sidecar counter would be a second source of truth the
 * trace-as-only-counter design forbids). The orchestrator composes this at
 * attempt-start boundaries alongside
 * the per-role ceiling (see `skills/gan/SKILL.md`).
 */

import { createError, type ConfigServerError } from '../config-server/errors.js';
import type { RoleAttemptState } from '../trace/reconcile.js';
import type { CeilingDecision, LoopDetectedFields } from './loop-detection.js';

// Role keys that must never index the role-keyed perRoleCounts accumulator: they
// are the prototype-pollution vectors. Mirrors `FORBIDDEN_KEYS` in
// `src/trace/reconcile.ts` (and `FORBIDDEN_ROLE_KEYS` in `./loop-detection.ts`)
// so the budget summation cannot regress the guard the trace layer establishes.
// A `__proto__`-named "role" in parsed trace data is hostile input, never a real
// agent, so it is skipped from the sum rather than allowed to fold into a total.
const FORBIDDEN_ROLE_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * The sentinel role id stamped on a sprint-wide budget halt's `role` field.
 *
 * `"sprint"` is **not** an agent: it has no entry in `DEFAULT_ATTEMPT_CEILINGS`
 * (so `checkRoleCeiling` never fires for it) and no `agentAttempt` events of its
 * own. It exists only to denote, in the shared `LoopDetected` halt contract,
 * that the halt is the aggregate sprint-wide budget rather than any one role
 * reaching its per-role ceiling. Kept distinct from the kebab-case agent role
 * ids so a trace reader can tell the two halt classes apart by the `role` field.
 */
export const SPRINT_ROLE = 'sprint';

/**
 * The default sprint-wide attempt budget: the maximum combined number of agent
 * invocations a single sprint may make before the framework halts it.
 *
 * This value is a **seed value, not data-derived.** It is the sum of the two
 * per-role ceilings (`gan-contract-proposer` 3 + `gan-generator` 3 = 6) plus 6
 * of headroom for the roles that carry no per-role ceiling but still consume
 * attempts: the single-attempt roles (clarifier, planner) and the once-per-output
 * roles (reviewer, evaluator) that run alongside each proposer/generator round.
 * A sprint that needs more than 12 combined attempts is almost certainly thrashing
 * across roles rather than converging, so halting at 12 errs toward stopping early
 * rather than burning tokens. A post-release audit re-tunes this against real
 * trace data — until then it is an opinionated guess, and this comment is the
 * rationale a reader gets. Mirrors the seed-value annotation on
 * `DEFAULT_ATTEMPT_CEILINGS` so the two seed defaults read consistently.
 */
export const DEFAULT_SPRINT_BUDGET = 12;

/**
 * The `sprintBudgetExceeded` evidence value carried on the `LoopDetected` error.
 *
 * @property totalAttempts the summed attempt count across every role; equals the
 *   sum of {@link perRoleCounts}'s values (an integer).
 * @property perRoleCounts a map from kebab-case role id to that role's integer
 *   attempt count, e.g. `{ "gan-generator": 3 }`. Built on a null-prototype
 *   object with the forbidden-key discipline so untrusted parsed role names
 *   cannot pollute it.
 */
export interface SprintBudgetEvidence {
  totalAttempts: number;
  perRoleCounts: Record<string, number>;
}

/**
 * Inputs to {@link checkSprintBudget}.
 *
 * @property attemptStateByRole the per-role attempt accounting reconstructed from
 *   the trace (`reconstructRecoveryState(...).attemptStateByRole`). The budget
 *   sums the `attemptCount` of every entry; no role is special-cased or excluded.
 * @property budget the sprint-wide budget to enforce; defaults to
 *   {@link DEFAULT_SPRINT_BUDGET} when omitted.
 */
export interface CheckSprintBudgetInput {
  attemptStateByRole: Record<string, RoleAttemptState>;
  budget?: number;
}

/**
 * Narrow an arbitrary value to a {@link SprintBudgetEvidence}.
 *
 * @param value the candidate, typically parsed from untrusted trace data.
 * @returns `true` iff `value` is an object with an integer `totalAttempts` and a
 *   `perRoleCounts` object whose every own value is an integer. Mirrors the
 *   {@link isRoleCeilingEvidence} validator pattern (typed narrowing +
 *   `Number.isInteger`). Pure; never throws. Note: this validates the *shape*,
 *   not the `totalAttempts == sum(perRoleCounts)` invariant — the producer
 *   (`buildSprintBudgetEvidence`) guarantees that, and a shape validator must not
 *   reject a structurally-valid value just because a caller passed an
 *   inconsistent one.
 */
export function isSprintBudgetEvidence(value: unknown): value is SprintBudgetEvidence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.totalAttempts !== 'number' || !Number.isInteger(v.totalAttempts)) return false;
  const counts = v.perRoleCounts;
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) return false;
  // hasOwnProperty-scoped iteration: only the map's own role keys are validated,
  // never an inherited member, so a null-prototype or plain object both validate.
  for (const key of Object.keys(counts as Record<string, unknown>)) {
    const count = (counts as Record<string, unknown>)[key];
    if (typeof count !== 'number' || !Number.isInteger(count)) return false;
  }
  return true;
}

/**
 * Fold a per-role attempt tally into a {@link SprintBudgetEvidence}: a
 * null-prototype `perRoleCounts` map plus the summed `totalAttempts`.
 *
 * @param attemptStateByRole the reconstructed per-role accounting to sum.
 * @returns the evidence value. `totalAttempts` is guaranteed to equal the sum of
 *   `perRoleCounts`'s values because both are folded from the same iteration.
 *   Pure; never throws.
 *
 * The accumulator is `Object.create(null)` and the loop iterates own keys with
 * `hasOwnProperty`, skipping the `__proto__`/`constructor`/`prototype` forbidden
 * keys — the same discipline `reconstructRecoveryState` uses — so a hostile
 * `__proto__`-named role in parsed trace data neither pollutes `Object.prototype`
 * nor silently corrupts the total: it is dropped from both the map and the sum.
 * Counts are installed via `Object.defineProperty` (not assignment) so that even
 * a forbidden key reaching this point would create a real own property rather
 * than walking the prototype setter.
 */
export function buildSprintBudgetEvidence(
  attemptStateByRole: Record<string, RoleAttemptState>,
): SprintBudgetEvidence {
  const perRoleCounts: Record<string, number> = Object.create(null) as Record<string, number>;
  let totalAttempts = 0;

  for (const role of Object.keys(attemptStateByRole)) {
    // Defence-in-depth: skip pollution-named roles before they index the
    // accumulator. They cannot be real configured roles, and folding them into
    // the total would let hostile input corrupt the budget sum.
    if (FORBIDDEN_ROLE_KEYS.has(role)) continue;
    // hasOwnProperty (not `in`/truthiness) because the input map may be
    // null-prototype and a count could legitimately be 0.
    if (!Object.prototype.hasOwnProperty.call(attemptStateByRole, role)) continue;

    const count = attemptStateByRole[role]?.attemptCount ?? 0;
    Object.defineProperty(perRoleCounts, role, {
      value: count,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    // Sum and map are folded from the same value in the same pass, so
    // totalAttempts == sum(perRoleCounts) holds by construction.
    totalAttempts += count;
  }

  return { totalAttempts, perRoleCounts };
}

/**
 * Decide whether a sprint has reached its sprint-wide attempt budget.
 *
 * Composes with — but is independent of — {@link checkRoleCeiling}: the budget
 * sums the attempts of *every* role (including the single-attempt clarifier and
 * planner, which the per-role table excludes) and halts on the aggregate, so a
 * sprint where no single role reaches its own ceiling can still halt here. The
 * orchestrator checks this at attempt-start boundaries alongside the per-role
 * ceiling; an in-flight attempt finishes before the next check.
 *
 * @param input the reconstructed {@link CheckSprintBudgetInput.attemptStateByRole}
 *   tally and an optional budget (defaults to {@link DEFAULT_SPRINT_BUDGET}).
 * @returns a {@link CeilingDecision} (shared with the per-role check so both halt
 *   paths return the same shape). `halt` is `true` iff the summed total has
 *   reached (`>=`) the budget; when halting, `fields` carries the `LoopDetected`
 *   structured fields with `reason: "sprintBudgetExceeded"`, `role: "sprint"`,
 *   `attempts` = the summed total, `ceiling` = the budget, and `evidence` a
 *   {@link SprintBudgetEvidence}. Pure; never throws.
 */
export function checkSprintBudget(input: CheckSprintBudgetInput): CeilingDecision {
  const budget = input.budget ?? DEFAULT_SPRINT_BUDGET;
  const evidence = buildSprintBudgetEvidence(input.attemptStateByRole);
  const attempts = evidence.totalAttempts;

  // `>=`, not `>`: the budget is the maximum combined attempts allowed, so once
  // the summed total reaches it the next attempt-start must halt rather than
  // spawn a further attempt of any role — matching the per-role ceiling's `>=`.
  if (attempts < budget) return { halt: false };

  const fields: LoopDetectedFields = {
    reason: 'sprintBudgetExceeded',
    // The sentinel role: this halt is the aggregate budget, not any one agent.
    role: SPRINT_ROLE,
    attempts,
    ceiling: budget,
    // The shared LoopDetectedFields.evidence is typed for the role-ceiling array;
    // the sprintBudgetExceeded discriminator carries an object instead. Cast at
    // this single seam (validated by isSprintBudgetEvidence in tests) rather than
    // widening the shared field for every discriminator.
    evidence: evidence as unknown as LoopDetectedFields['evidence'],
  };
  return { halt: true, fields };
}

/**
 * Render the user-facing prose halt message for a sprint-wide budget halt.
 *
 * Obeys the same user-facing-error discipline as the per-role
 * `renderRoleCeilingMessage`: it names no maintainer-only scripts and no
 * ecosystem/runtime tooling, refers to "the framework" / "ClaudeAgents", points
 * the user at the run's trace directory (the read-substrate for the halt), and
 * tells them to re-run with `--recover` after adjusting the prompt. The trace
 * path is templated, not hardcoded, so the central-store location can be
 * substituted by the caller.
 *
 * @param fields the structured halt fields (attempts and ceiling); `role` is the
 *   `"sprint"` sentinel and is not interpolated as an agent name.
 * @param traceDir the run's trace directory path to point the user at.
 * @returns the prose message. Pure; never throws.
 */
export function renderSprintBudgetMessage(
  fields: Pick<LoopDetectedFields, 'attempts' | 'ceiling'>,
  traceDir: string,
): string {
  return (
    `ClaudeAgents halted this sprint: the combined work across all roles reached ` +
    `${fields.attempts} attempts (the sprint-wide budget is ${fields.ceiling}) without ` +
    `the sprint converging, so the framework stopped it rather than keep cycling between ` +
    `roles. Trace files for this run are at ${traceDir}. ` +
    `Adjust the prompt or raise the budget, then re-run with --recover to resume.`
  );
}

/**
 * Construct the `LoopDetected` structured error for a sprint-wide budget halt.
 *
 * Reuses the framework's existing `createError('LoopDetected', ...)` factory —
 * the SAME error code, fields, and serialisation the per-role
 * `createLoopDetectedError` uses — so the budget halt is not a parallel error
 * path. Only the discriminator (`sprintBudgetExceeded`), the `"sprint"` role, and
 * the {@link SprintBudgetEvidence} evidence shape differ; the message comes from
 * {@link renderSprintBudgetMessage}.
 *
 * @param fields the structured halt fields to attach (from {@link checkSprintBudget}).
 * @param traceDir the run's trace directory, used to render the message.
 * @returns a constructed (not thrown) `ConfigServerError` with code
 *   `LoopDetected`. Pure; never throws (it constructs, it does not raise).
 */
export function createSprintBudgetError(
  fields: LoopDetectedFields,
  traceDir: string,
): ConfigServerError {
  return createError('LoopDetected', {
    message: renderSprintBudgetMessage(fields, traceDir),
    reason: fields.reason,
    role: fields.role,
    attempts: fields.attempts,
    ceiling: fields.ceiling,
    evidence: fields.evidence,
  });
}
