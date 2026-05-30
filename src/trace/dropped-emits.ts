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
 * Lifetime contract (read this before depending on the tally): the backing
 * `Map` lives for the lifetime of the importing process and is intentionally
 * unbounded across that lifetime. That is sound only because the sole intended
 * owner is the single long-lived config-server process, where the number of
 * distinct `runDir` keys is the number of runs that one server has serviced —
 * small and naturally bounded by operator cadence. A short-lived process (a
 * CLI invocation, a test) gets a fresh empty tally and discards it on exit, so
 * there is nothing to evict. Do **not** treat these functions as a general
 * cross-run accumulator from a process that picks arbitrary `runDir` strings:
 * doing so would grow the map without bound. No hard eviction ceiling is
 * imposed because honouring the single-owner contract makes one unnecessary.
 *
 * Process-scoped semantics fall out of the in-memory choice: a separate Node
 * process that imports `getDroppedEmits` sees `0` even when this process's
 * tally would have been positive, because there is no cross-process channel
 * by design.
 */

import path from 'node:path';

// Keyed on the canonicalised absolute `runDir`. `path.resolve` collapses the
// trailing-separator and `.`/`..`-segment variants of the same directory onto
// one key, so a caller that passes `runDir` on the failing emit and `runDir/`
// on the read (or vice versa) addresses a single counter rather than two
// silently-distinct ones.
const tally: Map<string, number> = new Map();

/**
 * Collapse the textual variants of one run directory onto a single key.
 * `path.resolve` normalises trailing separators and `.`/`..` segments; we then
 * strip any residual trailing separator so a root-only path still canonicalises
 * stably. The lookup never escapes the process, so this is purely about
 * de-duplicating keys for the same on-disk directory, not about path safety.
 */
function canonicalizeRunDir(runDir: string): string {
  const resolved = path.resolve(runDir);
  // Drop a trailing separator that path.resolve may keep for a filesystem root.
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    return resolved.slice(0, -1);
  }
  return resolved;
}

/**
 * Bump the dropped-emit counter for `runDir` by one. Creates the entry on
 * first call. Pure side effect: no I/O, no error.
 *
 * Lifetime: the increment lands in a process-lifetime map (see the module
 * doc). Intended to be called only from the long-lived config-server process;
 * the entry is never evicted before the process exits.
 *
 * @param runDir absolute path to the run directory whose emit was dropped.
 *   Canonicalised before use, so the trailing-slash and `.`/`..` variants of
 *   the same directory all address one counter.
 */
export function incrementDroppedEmits(runDir: string): void {
  const key = canonicalizeRunDir(runDir);
  const prior = tally.get(key) ?? 0;
  tally.set(key, prior + 1);
}

/**
 * Read the dropped-emit count for `runDir`. Returns `0` when no failure has
 * been recorded for the run in this process (either a happy-path run or a
 * separate process reading a tally that this one keeps).
 *
 * Lifetime: reads the same process-lifetime map `incrementDroppedEmits` writes
 * (see the module doc); a separate process sees `0` by design.
 *
 * @param runDir the run dir whose count to read. Canonicalised the same way as
 *   the increment side, so a different textual form of the same directory still
 *   reads its counter.
 * @returns the current count; never throws.
 */
export function getDroppedEmits(runDir: string): number {
  return tally.get(canonicalizeRunDir(runDir)) ?? 0;
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
