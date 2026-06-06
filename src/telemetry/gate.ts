/**
 * Telemetry gate predicate — the single owner of the question "should the
 * orchestrator emit telemetry for this run?".
 *
 * The predicate is a pure function over the parsed runtime flags so the
 * orchestrator's call-site (and the test suite) consult one helper rather
 * than open-coding the `--no-telemetry` check at every emission boundary.
 * Keeping the predicate in a named module also pins the contract: a run
 * invoked with `--no-telemetry` produces no `telemetry/` directory at any
 * point during or after the run, and the `trace/` subtree is untouched by
 * this gate.
 */

/**
 * Input shape for {@link shouldEmitTelemetry}. The orchestrator's argument
 * parser sets `noTelemetry: true` when `--no-telemetry` was supplied on the
 * `/gan` command line; an absent or false-valued flag means telemetry is on
 * (v1.0 ships telemetry on by default).
 *
 * @property noTelemetry whether the user passed `--no-telemetry` for this
 *   run. The flag is per-run, never per-sprint.
 */
export interface TelemetryGateInput {
  noTelemetry: boolean;
}

/**
 * Decide whether the run should emit `telemetry/config.json` at run start
 * and `telemetry/outcome.json` at run termination.
 *
 * The predicate is total over its input — there is no "unknown" return —
 * because every `/gan` invocation has either passed or not passed the flag.
 * Returns `true` when the orchestrator should call the writer pair, `false`
 * when it should skip both calls (the `telemetry/` directory then does not
 * get created at any point during the run).
 *
 * @param input the {@link TelemetryGateInput} carrying the parsed flag.
 * @returns `true` when telemetry is enabled (the v1.0 default); `false`
 *   when `--no-telemetry` was supplied. Pure; never throws.
 */
export function shouldEmitTelemetry(input: TelemetryGateInput): boolean {
  return !input.noTelemetry;
}
