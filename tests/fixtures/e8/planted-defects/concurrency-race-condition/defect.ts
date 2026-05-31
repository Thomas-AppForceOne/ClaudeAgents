/**
 * Defective `increment`: reads the counter, awaits a non-trivial delay, then
 * writes `read + 1`. Concurrent callers all observe the same pre-read value,
 * so N concurrent calls produce a final counter value far less than N.
 *
 * Out-of-contract bug: the initial contract says "calling N times yields a
 * counter of N"; the planted defect is the read-modify-write race.
 */
let counter = 0;

/**
 * Increment the shared counter.
 *
 * Demonstrably racy: the read happens before the await; the write happens
 * after. Concurrent invocations clobber each other.
 */
export async function increment(): Promise<number> {
  // BUG: read-modify-write without atomicity / serialisation.
  const read = counter;
  await new Promise((r) => setTimeout(r, 1));
  counter = read + 1;
  return counter;
}

/**
 * Test-only: return the current counter value. Exists so the reproduction
 * script can assert the final state.
 */
export function getCounter(): number {
  return counter;
}
