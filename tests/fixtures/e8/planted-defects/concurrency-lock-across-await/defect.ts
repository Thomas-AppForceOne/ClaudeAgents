/**
 * Defective `runOnce`: uses a boolean flag as if it were a mutex, but checks
 * the flag, then sets it, then awaits a long-running operation, then releases
 * the flag in a `finally`. The intent is mutual exclusion, but JavaScript's
 * single-threaded event loop means a second caller that arrives BEFORE the
 * first caller has set `inFlight = true` will observe `inFlight === false`,
 * so the check-set-await sequence is not atomic across the await boundary —
 * two callers can both run the critical section.
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
  // BUG: the check-set-await sequence is not atomic on the event loop. The
  // flag is held across the `await`, but a second caller arriving between
  // the synchronous `if (inFlight) return null` of the first caller and the
  // synchronous `inFlight = true` would still race — and more critically,
  // any awaited continuation inside `sideEffect` can re-enter via a sibling
  // microtask that observes the flag mid-operation.
  if (inFlight) return null;
  inFlight = true;
  try {
    return await sideEffect();
  } finally {
    inFlight = false;
  }
}
