/**
 * TypeScript shapes paired with the two telemetry JSON Schemas.
 *
 * Every type here is the structural mirror of a property the schema pins, so a
 * change to the schema must land alongside a change here (and vice versa) —
 * the writers cast their built envelopes to {@link TelemetryConfigV1} /
 * {@link TelemetryOutcomeV1} before serialising, and the test suite validates
 * the same envelope against the bundled schema, so a divergence between the
 * two surfaces fails both ways. The types are intentionally narrow: the
 * envelope and the enums are pinned, while the unstructured pieces (the
 * resolvedConfig field shapes F2 owns, the safetyHalt payload A1 owns) are
 * left as `Record<string, unknown>` rather than re-typed here.
 */

/**
 * The five run-level disposition values O3 defines. Derived from O2's
 * terminalReason via {@link import('./mapping.js').terminalReasonToDisposition};
 * see that function's doc for the verbatim ten-row mapping table.
 */
export type Disposition = 'success' | 'rejected' | 'halted' | 'aborted' | 'errored';

/**
 * The five per-sprint outcome values. Reuses the {@link Disposition}
 * vocabulary with `complete` substituted for `success` so a per-sprint
 * terminal-success reads as 'this sprint is done' rather than the
 * run-scoped 'this run succeeded'.
 */
export type SprintStatus = 'complete' | 'rejected' | 'halted' | 'aborted' | 'errored';

/**
 * The ten kebab-case terminalReason codes O2 owns. Mirrors
 * progress-v1's terminalReasonCode enum and the outcome schema's
 * terminalReason enum; the three sites must move in lockstep — adding an
 * eleventh code is a coordinated edit across all three.
 */
export type TerminalReason =
  | 'complete'
  | 'failed-evaluation-rejected'
  | 'aborted-contract-failed'
  | 'failed-max-attempts'
  | 'failed-budget'
  | 'failed-loop-detected'
  | 'aborted-by-user'
  | 'failed-clarifier-error'
  | 'aborted-planner-error'
  | 'aborted-validation-failed';

/**
 * Aggregate cost rollup. `complete` is the required discriminator: `true` when
 * the trace is verified-complete (R7's `droppedEmits === 0` at termination),
 * `false` when at least one best-effort emit was dropped and a real number was
 * lost. The six metric fields are non-negative integers summed from the T1
 * trace via R7's `aggregateRunSummary` — never hand-summed in this module.
 */
export interface Cost {
  /** Whether every cost-bearing event reached the trace; `false` means a
   * droppedEmits-flagged loss. Never omitted — its presence is unambiguous so
   * a reader cannot confuse 'verified complete' with 'unknown'. */
  complete: boolean;
  /** Sum of `tokensInput` across the run's `llmCall` events. */
  tokensInput: number;
  /** Sum of `tokensCached` across the run's `llmCall` events. */
  tokensCached: number;
  /** Sum of `tokensOutput` across the run's `llmCall` events. */
  tokensOutput: number;
  /** Count of `llmCall` events. */
  llmCallCount: number;
  /** Count of `toolCall` events. */
  toolCallCount: number;
  /** Wall-clock span between the first and last timestamped event, in ms. */
  wallClockMs: number;
}

/**
 * One per-sprint outcome record under {@link TelemetryOutcomeV1.sprints}.
 *
 * @property sprintNumber 1-indexed sprint position in the run plan.
 * @property status the sprint's terminal {@link SprintStatus}.
 * @property attemptCounts free-shape map of agent role-id to the count of
 *   attempts that role made within this sprint.
 */
export interface SprintEntry {
  sprintNumber: number;
  status: SprintStatus;
  attemptCounts: Record<string, number>;
}

/**
 * One safety-halt summary reference. The halt's full evidence lives in the
 * T1 trace; outcome.json carries only the breadcrumb a reader needs to
 * locate it.
 *
 * @property sprintNumber sprint where the halt fired.
 * @property safetyClass discriminator the A-series spec that owns the halt
 *   class defines (e.g. A1's `loopDetected`).
 * @property reason short human-readable cause string.
 */
export interface SafetyHaltEntry {
  sprintNumber: number;
  safetyClass: string;
  reason: string;
}

/**
 * Envelope wrapper carried by both `config.json` (with `capturedAt`) and
 * `outcome.json` (with `writtenAt` — see {@link TelemetryOutcomeEnvelope}).
 * Both envelopes pin the schema version so a v2 reader can fail loudly
 * when handed a v1 document rather than mis-parsing it.
 */
export interface TelemetryConfigEnvelope {
  schemaVersion: 1;
  capturedAt: string;
  runId: string;
}

/**
 * Outcome envelope; differs from {@link TelemetryConfigEnvelope} only in the
 * timestamp field name (`writtenAt` vs `capturedAt`) so the two artefacts can
 * be told apart at a glance.
 */
export interface TelemetryOutcomeEnvelope {
  schemaVersion: 1;
  writtenAt: string;
  runId: string;
}

/**
 * Top-level shape of `telemetry/config.json` at schema v1. `resolvedConfig`
 * is left structurally open here because F2 owns its inner shape; the schema
 * pins the ten required field names and tolerates additive forward-compat
 * fields, and the types mirror that posture.
 */
export interface TelemetryConfigV1 {
  envelope: TelemetryConfigEnvelope;
  resolvedConfig: ResolvedConfigSnapshot;
}

/**
 * The ten getResolvedConfig() top-level fields the schema requires, kept
 * structurally open (each is `Record<string, unknown>` / `unknown[]`) so this
 * module does not lock the inner shapes F2 owns. A caller passing a richer
 * structurally-typed object is welcome — the broader interface accepts it.
 */
export interface ResolvedConfigSnapshot {
  apiVersion: string;
  schemaVersions: Record<string, unknown>;
  runtimeMode: Record<string, unknown>;
  stacks: Record<string, unknown>;
  overlay: Record<string, unknown>;
  discarded: unknown[];
  additionalContext: Record<string, unknown>;
  issues: unknown[];
  warnings: unknown[];
  modules: Record<string, unknown>;
  [extra: string]: unknown;
}

/**
 * Top-level shape of `telemetry/outcome.json` at schema v1. `cost` is
 * nullable to encode the trace-unavailable degraded path (returning a null
 * cost rather than failing the write); `humanReviews` is the reserved E6
 * v1.2 slot, an empty array at v1.0.
 */
export interface TelemetryOutcomeV1 {
  envelope: TelemetryOutcomeEnvelope;
  disposition: Disposition;
  terminalReason: TerminalReason;
  sprints: SprintEntry[];
  cost: Cost | null;
  safetyHalts: SafetyHaltEntry[];
  humanReviews: unknown[];
}

/**
 * Input to {@link import('./writer-config.js').writeTelemetryConfig}.
 *
 * @property runDir absolute path of the run directory; the writer derives
 *   `<runDir>/telemetry/config.json` from it and creates the parent
 *   `telemetry/` directory if missing.
 * @property runId run identifier in `<YYYYMMDDTHHMMSS>-<4 hex>` form;
 *   embedded in the envelope verbatim.
 * @property resolvedConfig the full F2 snapshot the artefact records.
 * @property capturedAt the RFC3339-ms timestamp embedded in the envelope.
 *   The caller supplies the value rather than the writer reading the clock,
 *   so the same moment captured by the orchestrator's run-start event can
 *   be embedded both here and in the T1 trace without a clock skew.
 */
export interface WriteTelemetryConfigInput {
  runDir: string;
  runId: string;
  resolvedConfig: ResolvedConfigSnapshot;
  capturedAt: string;
}

/**
 * Input to {@link import('./writer-outcome.js').writeTelemetryOutcome}.
 *
 * @property runDir absolute path of the run directory; the writer derives
 *   `<runDir>/telemetry/outcome.json` from it and reads the T1 trace under
 *   `<runDir>/trace/` for the `cost` rollup.
 * @property runId embedded in the envelope verbatim.
 * @property terminalReason the O2 code that drove the run's termination;
 *   the writer derives `disposition` from it via the mapping module.
 * @property sprints per-sprint outcome records the orchestrator reconstructed
 *   at termination.
 * @property safetyHalts summary references to the run's safety halts; empty
 *   array on a non-halted run.
 * @property writtenAt the RFC3339-ms timestamp embedded in the envelope.
 *   The caller supplies it so the run-end moment is consistent across this
 *   artefact, the T1 trace's terminal milestone, and progress.json.
 * @property droppedEmits optional explicit dropped-emit count, intended for
 *   cross-process callers. When omitted (the in-process case), the writer
 *   falls back to `getDroppedEmits(runDir)` — the in-memory tally R7
 *   maintains in the long-lived config-server process. When provided, the
 *   writer uses the explicit value verbatim and does **not** call
 *   `getDroppedEmits`. The seam exists because the dropped-emit tally is
 *   process-scoped by design (see `src/trace/dropped-emits.ts`): a writer
 *   that runs in a different process from the trace emitter would otherwise
 *   read 0 and misreport `cost.complete` as `true` after a real loss. The
 *   `cost.complete` derivation remains `droppedEmits === 0` in both modes;
 *   only the source of the count differs.
 */
export interface WriteTelemetryOutcomeInput {
  runDir: string;
  runId: string;
  terminalReason: TerminalReason;
  sprints: SprintEntry[];
  safetyHalts: SafetyHaltEntry[];
  writtenAt: string;
  droppedEmits?: number;
}
