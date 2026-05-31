/**
 * Prior-revision baseline of `openPort`. Kept here as the diff reference for
 * the regression-class fixture: comparing this file to `defect.ts` shows the
 * bounds check that the current revision removed. The no-new-defects criterion
 * is computed off precisely this kind of delta.
 */

/**
 * Bind a fake socket on `port` and return a handle.
 *
 * @param port TCP port number, expected in the unprivileged range.
 * @throws when `port` is outside 1024..65535.
 */
export function openPort(port: number): { port: number } {
  if (port < 1024 || port > 65535) {
    throw new Error('invalid port');
  }
  return { port };
}
