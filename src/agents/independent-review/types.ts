/**
 * Shared type vocabulary for the independent-review subsystem.
 *
 * The independent-reviewer agent writes a JSON artefact per sprint attempt
 * whose shape is defined by `schemas/independent-review-v1.json`. This module
 * is the TypeScript mirror of that schema's shape: it carries no runtime
 * logic — only the structural types the validation layer consumes — so that
 * any downstream module (the reproduction-gate pure function in this folder,
 * the orchestrator's renegotiation router, future tooling) can import the
 * shape without taking a dependency on the validation runtime.
 *
 * Two structural conventions hold across these shapes and are stated once
 * here rather than on each field:
 * - Finding kinds are a discriminated union on `kind`. The two variants
 *   ({@link CommandFinding}, {@link InspectionFinding}) carry different
 *   evidence fields; mixing them up would let an inspection-only finding be
 *   re-run as a command, which is exactly the false-positive the reproduction
 *   gate is built to prevent.
 * - Every count is `number`, not `bigint` or a branded numeric, because the
 *   bundle's tally is small (a sprint has at most a few hundred findings) and
 *   the downstream JSON round-trip would lose any richer encoding anyway.
 */

/**
 * Severity tier per the measurement-vs-gating convention.
 *
 * - `blocker` — a defect the reviewer believes a downstream criterion must
 *   gate on. Triggers a renegotiation round if not covered by an existing
 *   criterion.
 * - `warning` — a defect surfaced and routed; may trigger a renegotiation
 *   round, may also be downgraded to advisory by downstream audit.
 * - `advisory` — measurement only. Never gates a sprint.
 */
export type Severity = 'blocker' | 'warning' | 'advisory';

/**
 * Discriminator between the two evidence kinds a finding can carry.
 *
 * - `command` — the defect reproduces under a deterministic shell command
 *   (a failing test, a `grep` match, a build error). The reproduction guard
 *   re-runs the command and drops the finding if its exit code is non-zero.
 * - `inspection` — the defect is a code-anchored claim with no runnable
 *   reproduction. Carries an `evidencePointer` for downstream audit; the
 *   reproduction guard never drops an inspection finding (its audit is the
 *   contract-reviewer's job, not this module's).
 */
export type FindingKind = 'command' | 'inspection';

/**
 * Fields every finding carries regardless of kind. The discriminated union
 * below extends this with kind-specific evidence fields.
 */
interface BaseFinding {
  /**
   * Stable slug identifying the finding within the bundle. ASCII letters,
   * digits, hyphen, underscore. Used as a join key when the finding is
   * promoted to a criterion downstream.
   */
  id: string;
  /** Severity tier — see {@link Severity}. */
  severity: Severity;
  /**
   * Short class name the reviewer used to group the finding (e.g.
   * `'correctness'`, `'security'`, `'concurrency'`). Free-form; the schema
   * does not enumerate the set so a reviewer can surface a novel class
   * without a schema bump.
   */
  category: string;
  /** Repo-relative POSIX path of the file the finding concerns. */
  file: string;
  /** 1-based line number in the cited file at the tip of the run branch. */
  line: number;
  /** What the defect is, in one or two sentences. Non-empty. */
  description: string;
  /** A specific, testable restatement the proposer can adopt as a criterion. */
  suggestedCriterion: string;
}

/**
 * Command-reproducible finding: carries a shell command the reproduction
 * gate runs to confirm the defect.
 *
 * Invariants the caller must uphold:
 * - `reproductionCommand` is a non-empty shell command runnable from the
 *   worktree root.
 * - `reproduced` records what the reviewer observed locally; the
 *   reproduction gate ignores this field when deciding whether to drop the
 *   finding (it re-runs the command itself).
 */
export interface CommandFinding extends BaseFinding {
  kind: 'command';
  /** Shell command the reproduction gate runs from the worktree root. */
  reproductionCommand: string;
  /**
   * `true` if the reviewer ran the command locally and saw the failure;
   * `false` if the reviewer asserted the defect without local execution.
   * Informational only — the reproduction gate's verdict is the arbiter.
   */
  reproduced: boolean;
}

/**
 * Inspection finding: a code-anchored claim with no runnable reproduction.
 * The reproduction gate passes inspection findings through unchanged; their
 * downstream audit is the contract-reviewer's well-foundedness check.
 */
export interface InspectionFinding extends BaseFinding {
  kind: 'inspection';
  /**
   * `file:line` plus the specific claim a downstream auditor uses to
   * confirm the defect actually exists in the cited code. Non-empty.
   */
  evidencePointer: string;
}

/** Discriminated union over the two finding kinds. */
export type Finding = CommandFinding | InspectionFinding;

/**
 * Per-severity tally the reviewer wrote alongside the findings list, plus a
 * `dropped` counter the reproduction gate maintains as it drops
 * non-reproducing command findings.
 */
export interface ReviewSummary {
  /** Count of findings with severity `blocker` in the post-gate list. */
  blockers: number;
  /** Count of findings with severity `warning` in the post-gate list. */
  warnings: number;
  /** Count of findings with severity `advisory` in the post-gate list. */
  advisories: number;
  /**
   * Count of command findings the reproduction gate dropped because their
   * `reproductionCommand` did not reproduce. The reviewer's initial bundle
   * sets this to 0; the gate increments it as it drops findings.
   */
  dropped: number;
}

/**
 * The top-level artefact shape the independent-reviewer agent writes per
 * sprint attempt. Mirrors `schemas/independent-review-v1.json`.
 */
export interface IndependentReviewBundle {
  /** 1-based sprint index within the run. */
  sprintNumber: number;
  /** Uppercase ASCII letter naming the generator attempt (A, B, C, ...). */
  attemptLetter: string;
  /**
   * Index of the locked criteria revision this review was authored against.
   * 0 for the original lock; incremented each renegotiation round. The
   * orchestrator supplies this value as input to the reviewer and is the
   * sole writer of the canonical sequence.
   */
  contractRevision: number;
  /** Ordered list of findings; may be empty (a clean review). */
  findings: Finding[];
  /** Per-severity tally; see {@link ReviewSummary}. */
  summary: ReviewSummary;
}

/**
 * Result the injected command runner returns for one `reproductionCommand`
 * invocation. Only the exit code is load-bearing for the reproduction gate;
 * stdout and stderr are surfaced so the orchestrator can log them alongside
 * the dropped-finding record without re-running the command.
 *
 * @property exitCode the command's exit status. `0` keeps the finding; any
 *   non-zero value drops it with reason `"reproduction-failed"`.
 * @property stdout the command's captured standard output (may be empty).
 * @property stderr the command's captured standard error (may be empty).
 */
export interface CommandRunnerResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Function the orchestrator injects to execute a finding's
 * `reproductionCommand`. Keeping execution pluggable lets the pure
 * validation function in this folder stay free of `child_process` and
 * `fs` so it remains trivially testable (and so the validation layer can
 * be exercised without ever running shell).
 *
 * Implementations MUST treat `cmd` as a shell command string and run it
 * relative to a working directory the caller controls; the runner is the
 * single point that crosses into the H1-confined `Bash` tool, so it is
 * also the single point at which command injection prevention applies —
 * callers must vet `cmd` before delegating to a runner that interpolates
 * it into a shell.
 *
 * @param cmd the `reproductionCommand` string from the finding, verbatim.
 * @returns the {@link CommandRunnerResult} the gate consumes.
 */
export type CommandRunner = (cmd: string) => CommandRunnerResult;

/**
 * Why the reproduction gate dropped a finding. Single value today
 * (`"reproduction-failed"`) but a string union so future drop reasons
 * (e.g. malformed command) can be added without rewriting callers.
 */
export type DropReason = 'reproduction-failed';

/**
 * One entry in the gate's drop ledger: which finding was dropped and why.
 * Returned alongside the kept-findings bundle so the orchestrator can log
 * each drop and surface it for the audit trail.
 */
export interface DroppedFindingRecord {
  /** The dropped finding's `id`, matching its entry in the original bundle. */
  id: string;
  /** Why the gate dropped it — see {@link DropReason}. */
  reason: DropReason;
}

/**
 * Result of running the reproduction gate over a bundle: the rewritten
 * bundle with non-reproducing command findings removed plus the drop
 * ledger.
 *
 * Invariants:
 * - `bundle.summary.blockers/warnings/advisories` are recomputed from the
 *   kept findings; the reviewer-supplied tallies are NOT trusted.
 * - `bundle.summary.dropped` equals
 *   `originalBundle.summary.dropped + droppedReasons.length`.
 * - `droppedReasons` is in the same order as the original bundle's
 *   findings.
 */
export interface ValidateFindingsResult {
  /** The bundle with non-reproducing command findings removed. */
  bundle: IndependentReviewBundle;
  /** Per-finding drop records, in original-order. */
  droppedReasons: DroppedFindingRecord[];
}
