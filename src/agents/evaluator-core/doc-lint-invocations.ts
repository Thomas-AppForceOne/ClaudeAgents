/**
 * Q5 layer (b) — per-stack `docLintCmd` invocation emission.
 *
 * The direct structural mirror of `audit-commands.ts`: for each active
 * stack that declares a `docLintCmd`, emits one plan row carrying the
 * verbatim command, the owning stack's own `scope`, and the carried
 * `severity`/`baseline`/`absenceSignal`. Stacks without `docLintCmd` are
 * silently skipped — the absence is itself the signal, exactly as a stack
 * without `auditCmd` produces no audit row.
 *
 * Purity contract (load-bearing, per E3's "pure function over (snapshot,
 * sprint plan, worktree state)" rule): this function only *emits* the
 * invocation; it never runs the command, never reads a git base ref, and
 * never applies the severity gate. `EvaluatorCoreSnapshot`/`WorktreeState`
 * carry no base-ref input, so the baseline-relative comparison
 * (pre-existing vs. introduced undocumented symbol), the absence detection,
 * and the severity-driven gates-or-warns routing must all execute
 * downstream at the layer that runs `auditCmd`/`lintCmd` (the evaluator
 * agent). Pushing any of that here would break the carve-out's purity.
 * Every behaviour is keyed off the values this row carries; the carve-out's
 * sole job is to carry them faithfully.
 *
 * All commands flow from `snapshot.activeStacks[*].docLintCmd` — the
 * carve-out hard-codes no ecosystem-specific doc-lint tooling, which is
 * what keeps the multi-stack guard rail (synthetic-second + polyglot
 * fixtures + `lint-no-stack-leak`) correct by construction.
 */

import type { EvaluatorCoreSnapshot, EvaluatorPlan } from './types.js';

/**
 * The `baseline` applied when a stack's `docLintCmd` omits the field.
 *
 * Per Q5's "Integrity probes default to delta/ratchet semantics"
 * convention, an unspecified baseline means delta: a pre-existing
 * undocumented export in the base ref does not fail the run, only a
 * regression in the sprint's diff does. Filling the default here (rather
 * than leaving the row's `baseline` undefined for the downstream layer to
 * re-derive) keeps the spec default single-homed and the emitted row's
 * shape total — every row carries a concrete `baseline`.
 */
const DEFAULT_BASELINE = 'delta' as const;

/**
 * Emit one `docLintInvocations` row per active stack that declares a
 * `docLintCmd`, scoped to that stack's own `scope`, carrying its
 * `command`/`severity`/`baseline`/`absenceSignal`.
 *
 * @param snapshot the cascaded evaluator-core snapshot. Only
 *   `activeStacks[*].{name,scope,docLintCmd}` are read here; a stack with
 *   no `docLintCmd` contributes no row. The snapshot is the single source
 *   of every command — the carve-out injects no ecosystem default.
 *
 * Failure modes: pure and total — never throws. A stack without
 * `docLintCmd` is a silent skip (no row), not an error; there is no
 * implicit "no doc-lint tool configured" placeholder row. A `docLintCmd`
 * that omits `baseline` is emitted with the `delta` default rather than an
 * undefined `baseline`.
 *
 * Side effects: none — a pure mapping over the snapshot. The function
 * runs no command, consults no git base ref, opens no file, and performs
 * no gating; the caller (the plan-builder) depends on that purity to
 * assemble the full plan without a per-stack abort path or a base-ref
 * dependency.
 *
 * Invariants the caller relies on:
 *   - `command`, `severity`, and `absenceSignal` are copied verbatim from
 *     the stack's `docLintCmd`; they are never synthesised.
 *   - `scope` is the *owning* stack's own `scope` (a defensive copy),
 *     never another stack's — this is the polyglot scope-isolation
 *     guarantee FUNC-2 asserts in the golden.
 *   - `baseline` is always a concrete `'delta' | 'absolute'`: the stack's
 *     value when present, otherwise the `delta` default.
 *   - The returned array is sorted by `stack`, so the assembled plan is
 *     byte-stable across calls (the deterministic-golden contract,
 *     parallel to `buildAuditCommands`).
 *
 * @returns the doc-lint invocation rows for the evaluator plan
 *   (`EvaluatorPlan['docLintInvocations']`), sorted by `stack`.
 */
export function buildDocLintInvocations(
  snapshot: EvaluatorCoreSnapshot,
): EvaluatorPlan['docLintInvocations'] {
  const rows: EvaluatorPlan['docLintInvocations'] = [];
  for (const stack of snapshot.activeStacks) {
    // A stack without `docLintCmd` runs no deterministic doc-lint; emit
    // nothing for it (parity with `buildAuditCommands`' `auditCmd` skip).
    if (!stack.docLintCmd) continue;
    rows.push({
      stack: stack.name,
      command: stack.docLintCmd.command,
      // The owning stack's own scope — copied defensively so a downstream
      // mutation of the row cannot reach back into the snapshot. Carrying
      // *this* stack's scope (never another's) is what confines the
      // command to its ecosystem's files in a polyglot run.
      scope: stack.scope.slice(),
      severity: stack.docLintCmd.severity,
      // Apply the spec's `delta` default at emission so the row's
      // `baseline` is always concrete; the downstream layer keys its
      // delta-vs-absolute comparison off this value and must never see
      // `undefined`.
      baseline: stack.docLintCmd.baseline ?? DEFAULT_BASELINE,
      absenceSignal: stack.docLintCmd.absenceSignal,
    });
  }
  // Sort by `stack` (locale-fixed, like `buildAuditCommands`) so the plan
  // serialises identically across calls and machines — the golden diff in
  // the pipeline-check harness depends on this byte-stability.
  rows.sort((a, b) =>
    a.stack.localeCompare(b.stack, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return rows;
}
