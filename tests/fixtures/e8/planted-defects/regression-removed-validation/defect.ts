/**
 * Defective `openPort`: the prior revision validated `port >= 1024 && port <=
 * 65535` before binding; the current revision removes the bounds check, so a
 * `port = -1` argument reaches the underlying bind() and crashes the runtime.
 *
 * Out-of-contract bug: the no-new-defects criterion-class catches this as a
 * delta-regression — a check that the prior revision had is missing.
 */

/**
 * Bind a fake socket on `port` and return a handle. Real implementation
 * elided; the regression is the missing bounds check above the bind call.
 *
 * @param port TCP port number, expected in the unprivileged range.
 */
export function openPort(port: number): { port: number } {
  // BUG: prior revision had `if (port < 1024 || port > 65535) throw new
  // Error('invalid port');` immediately above this line. The check was
  // removed in the current diff — caught by the no-new-defects delta.
  return { port };
}
