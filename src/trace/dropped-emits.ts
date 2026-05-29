/**
 * Per-run `droppedEmits` tally — the in-memory signal of an emit that the
 * write path failed to land.
 *
 * The tally is scoped to the long-lived config-server process and addressed by
 * `runDir`: every dropped emit increments the counter for that run, and a
 * later `aggregateRunSummary({ runDir })` call reads it back. The counter
 * **must** live in memory, not on disk: it exists to flag exactly the
 * failure mode (a disk-full or unwritable `events/` directory) that would
 * also prevent an on-disk counter from being written, so persisting it would
 * share the failure domain it is supposed to surface.
 *
 * Process-scoped semantics fall out of the in-memory choice: a separate Node
 * process that imports `getDroppedEmits` sees `0` even when this process's
 * tally would have been positive, because there is no cross-process channel
 * by design.
 */

// The keying choice is the canonical absolute `runDir` (as the caller passed
// it on the failing emit). `aggregateRunSummary` is the only documented
// reader and threads the same `runDir` through, so a single Map indexed on
// runDir is the simplest correct shape — and the lookup never escapes the
// process, so no further normalisation is necessary.
const tally: Map<string, number> = new Map();

/**
 * Bump the dropped-emit counter for `runDir` by one. Creates the entry on
 * first call. Pure side effect: no I/O, no error.
 *
 * @param runDir absolute path to the run directory whose emit was dropped.
 *   Used verbatim as the Map key — callers that resolve / normalise the path
 *   beforehand will get a single entry; callers that pass different string
 *   forms (e.g. with/without trailing slash) will end up with separate keys.
 *   The convention is to pass the same `runDir` the emit handler was given.
 */
export function incrementDroppedEmits(runDir: string): void {
  const prior = tally.get(runDir) ?? 0;
  tally.set(runDir, prior + 1);
}

/**
 * Read the dropped-emit count for `runDir`. Returns `0` when no failure has
 * been recorded for the run in this process (either a happy-path run or a
 * separate process reading a tally that this one keeps).
 *
 * @param runDir the run dir whose count to read.
 * @returns the current count; never throws.
 */
export function getDroppedEmits(runDir: string): number {
  return tally.get(runDir) ?? 0;
}

/**
 * Test-only helper — clear the tally. Production callers do not need this:
 * the process restart that would clear it is the documented reset mechanism.
 * Tests use it between cases so one test's increments do not bleed into the
 * next.
 */
export function resetDroppedEmitsForTests(): void {
  tally.clear();
}
