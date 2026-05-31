/**
 * Defective `runOnce`: uses a boolean flag as if it were a mutex, but checks
 * the flag, then awaits, then sets the flag inside the critical section. Two
 * concurrent callers can both see `inFlight === false` between the check and
 * the synchronous set, so the "critical section" runs twice.
 *
 * Out-of-contract bug: the initial contract says "the side-effect runs at
 * most once concurrently"; the planted defect is that a boolean flag is not a
 * lock primitive across an await boundary.
 */
let inFlight = false;

/**
 * Run `sideEffect` while preventing concurrent invocations. Returns `null`
 * when a call is already in flight.
 *
 * @param sideEffect async unit of work to serialise.
 */
export async function runOnce<T>(sideEffect: () => Promise<T>): Promise<T | null> {
  // BUG: the check-await-set sequence is not atomic on the event loop.
  // A second caller observes `inFlight === false` and enters the critical
  // section concurrently.
  if (inFlight) return null;
  const result = await sideEffect();
  inFlight = true;
  try {
    return result;
  } finally {
    inFlight = false;
  }
}
