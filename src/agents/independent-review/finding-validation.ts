/**
 * Pure-function reproduction gate for the independent-review bundle.
 *
 * The reviewer agent emits a bundle of findings; before any finding is
 * promoted into the proposer's criteria, the orchestrator must re-run each
 * command-kind finding's `reproductionCommand` and drop the finding if it
 * does not actually reproduce. This module is the deterministic, pluggable
 * core of that gate.
 *
 * Why a pure function (no `child_process`, no `fs`, no global state):
 * - The orchestrator is the only legitimate caller of `Bash` under H1
 *   confinement. Centralising shell execution in an injected runner keeps
 *   this module out of the confinement boundary entirely — the gate's
 *   logic can be unit-tested with a spy runner, and the orchestrator can
 *   swap runner implementations (sync, async-wrapped, dry-run for replay)
 *   without rewriting the gate.
 * - Inspection findings carry no runnable reproduction; their downstream
 *   audit is the contract-reviewer's well-foundedness check, deliberately
 *   out of scope here. Dropping an inspection finding for "not reproduced"
 *   would defeat the role's purpose, so the gate routes inspection
 *   findings through unchanged and never invokes the runner for them.
 *
 * The gate also recomputes the per-severity tally from the kept findings —
 * the reviewer-supplied counts are NOT trusted because a dropped finding
 * would otherwise leave a stale tally that the orchestrator's downstream
 * router would key on incorrectly.
 */

import type {
  CommandRunner,
  CommandRunnerResult,
  DroppedFindingRecord,
  Finding,
  IndependentReviewBundle,
  ReviewSummary,
  ValidateFindingsResult,
} from './types.js';

/**
 * Defence-in-depth shape check on `reproductionCommand`. The schema in
 * `schemas/independent-review-v1.json` is the primary vetting layer —
 * the same character class is encoded as the field's `pattern` so a
 * schema-valid bundle never carries any of these bytes. This colocated
 * regex exists so a caller that skipped validation cannot funnel shell
 * metacharacters into the runner; the two layers must stay in sync.
 * Keep this expression and the schema `pattern` aligned.
 *
 * Bans: `;`, `&`, `|`, backtick, `$`, `<`, `>`, `\n`, `\r`, NUL, and
 * `\`. Does NOT ban spaces, single/double quotes, hyphen, slash,
 * colon, equals, dot — the legitimate shape of e.g.
 * `pnpm vitest run path/to/file.test.ts` or
 * `grep -nE 'foo' src/x.ts`.
 */
const UNSAFE_COMMAND_CHARACTERS = /[;&|`$<>\n\r\0\\]/;

/**
 * Run the reproduction gate over a review bundle and return the kept
 * findings plus the drop ledger.
 *
 * Algorithm:
 * 1. Walk `bundle.findings` in order.
 * 2. For each `kind: "inspection"` finding, keep it unchanged. The runner
 *    is deliberately NOT invoked; an inspection finding's audit is a
 *    different role's job (see module note).
 * 3. For each `kind: "command"` finding, first check the
 *    `reproductionCommand` against {@link UNSAFE_COMMAND_CHARACTERS};
 *    if it carries a banned byte, drop with reason
 *    `"reproduction-unsafe"` WITHOUT invoking the runner. Otherwise
 *    invoke `runner(reproductionCommand)` inside a try/catch. If the
 *    runner throws, drop with reason `"reproduction-errored"` and
 *    continue the walk. Otherwise, if the result's `exitCode` is `0`,
 *    keep the finding; if non-zero, drop with reason
 *    `"reproduction-failed"`.
 * 4. Rebuild `summary` from the kept findings:
 *    `blockers`/`warnings`/`advisories` are recomputed from severities;
 *    `dropped` is `originalSummary.dropped + droppedReasons.length`.
 *
 * Determinism: pure function. Given the same `bundle` and a `runner` that
 * is itself deterministic, the result is byte-identical run-to-run.
 *
 * Failure modes: the gate's verdict on any command finding is exactly
 * one of {kept, `reproduction-failed`, `reproduction-unsafe`,
 * `reproduction-errored`}; throws propagate from neither path. The walk
 * always runs to completion — a synchronously-throwing runner is caught
 * per finding and recorded as `reproduction-errored` rather than
 * truncating the kept-list or the drop ledger. A
 * `reproductionCommand` carrying shell metacharacters that slipped past
 * the schema (or arrived via an unvalidated bundle) is refused at the
 * gate with `reproduction-unsafe` BEFORE the runner is invoked. The
 * function does not throw on a malformed runner result or a missing
 * field; a caller that hands it an unvalidated bundle whose shape
 * violates the discriminator contract will see whatever the runtime
 * would produce (typically a `TypeError`).
 *
 * Invariants the caller must uphold:
 * - `bundle` MUST have been validated against
 *   `schemas/independent-review-v1.json` before being passed in. The gate
 *   relies on the discriminator (`kind`) being one of the two known values
 *   and on the kind-specific evidence fields being present. The gate
 *   ALSO performs a defence-in-depth shape check on
 *   `reproductionCommand` (see {@link UNSAFE_COMMAND_CHARACTERS}) so a
 *   caller that skipped validation still cannot funnel shell
 *   metacharacters into the runner.
 * - `runner` MAY throw synchronously; the gate catches per finding and
 *   records `reproduction-errored`. Implementing safe command execution
 *   remains the runner's contract, but the gate no longer relies on
 *   that contract being honoured.
 *
 * Side effects: none. The function does not mutate `bundle` or any of its
 * findings — it builds a new bundle from cloned finding objects so a
 * subsequent caller cannot observe a mutated reviewer artefact.
 *
 * @param bundle the reviewer-authored bundle (schema-valid).
 * @param runner the injected command runner; see {@link CommandRunner}.
 * @returns the kept-findings bundle plus the drop ledger; see
 *   {@link ValidateFindingsResult}.
 */
export function validateFindings(
  bundle: IndependentReviewBundle,
  runner: CommandRunner,
): ValidateFindingsResult {
  const kept: Finding[] = [];
  const droppedReasons: DroppedFindingRecord[] = [];

  // Walk in original order: the drop ledger's ordering is part of the
  // contract so downstream logging and audit-trail rendering can line up
  // each drop with the reviewer's original finding list at a glance.
  for (const finding of bundle.findings) {
    if (finding.kind === 'inspection') {
      // Inspection findings are deliberately not re-run. Their audit is
      // the contract-reviewer's well-foundedness check; treating them as
      // droppable here would erase exactly the defect classes the
      // independent reviewer exists to surface (correctness/security
      // claims with no runnable reproduction).
      kept.push(cloneFinding(finding));
      continue;
    }

    // Defence-in-depth shape check: the schema is the primary vetting
    // layer (see schemas/independent-review-v1.json reproductionCommand
    // pattern), but a caller that skipped validation should not be
    // able to funnel shell metacharacters into the runner. Refuse at
    // the gate BEFORE invoking the runner so the audit trail records
    // 'reproduction-unsafe' distinctly from a benign exit-non-zero.
    if (UNSAFE_COMMAND_CHARACTERS.test(finding.reproductionCommand)) {
      droppedReasons.push({ id: finding.id, reason: 'reproduction-unsafe' });
      continue;
    }

    // The runner is the single boundary into H1-confined Bash; a throw
    // here means the gate could not adjudicate. Record the per-finding
    // verdict so the walk continues and downstream renegotiation sees
    // the full ledger rather than a silently-truncated prefix.
    let result: CommandRunnerResult;
    try {
      result = runner(finding.reproductionCommand);
    } catch {
      droppedReasons.push({ id: finding.id, reason: 'reproduction-errored' });
      continue;
    }
    if (result.exitCode === 0) {
      kept.push(cloneFinding(finding));
      continue;
    }
    droppedReasons.push({ id: finding.id, reason: 'reproduction-failed' });
  }

  const summary: ReviewSummary = {
    blockers: countBySeverity(kept, 'blocker'),
    warnings: countBySeverity(kept, 'warning'),
    advisories: countBySeverity(kept, 'advisory'),
    // The cumulative-`dropped` convention (not a per-run delta) lets a
    // downstream consumer read the field as a running total when a future
    // re-validation pass runs the gate again, without re-reading the
    // previous bundle.
    dropped: bundle.summary.dropped + droppedReasons.length,
  };

  return {
    bundle: {
      sprintNumber: bundle.sprintNumber,
      attemptLetter: bundle.attemptLetter,
      contractRevision: bundle.contractRevision,
      findings: kept,
      summary,
    },
    droppedReasons,
  };
}

/**
 * Shallow clone of a finding object. Findings hold only primitive fields,
 * so a shallow clone is a sufficient defensive copy and keeps the cloned
 * value structurally equal to the input under deep-equal. A deep clone
 * (e.g. via `structuredClone`) would also work but would impose a
 * dependency on a global the test runner may not always provide.
 */
function cloneFinding<T extends Finding>(finding: T): T {
  return { ...finding };
}

/**
 * Count findings with the given severity. Centralised so the three calls
 * in {@link validateFindings} share one implementation and an off-by-one
 * cannot creep into one but not the others.
 */
function countBySeverity(findings: readonly Finding[], severity: Finding['severity']): number {
  let n = 0;
  for (const f of findings) {
    if (f.severity === severity) n += 1;
  }
  return n;
}
