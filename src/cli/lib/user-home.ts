
/**
 * Resolution of the user's home directory for the CLI.
 *
 * The `user` tier (the user-tier overlay and customized stack files) lives
 * under the home directory, so commands that touch it need a single, testable
 * place to discover where "home" is. This module is that place.
 */

/**
 * Resolve the directory the CLI should treat as the user's home.
 *
 * The precedence is fixed and load-bearing: `GAN_USER_HOME` first (the
 * test/override seam, so a hermetic run can redirect the user tier away from
 * the real home), then `HOME` (POSIX), then `USERPROFILE` (Windows). The first
 * env var holding a non-empty string wins.
 *
 * @returns the resolved home path, or `null` when none of the three env vars
 *   is set to a non-empty string. `null` is a value the caller must handle —
 *   this function never throws — and signals that any user-tier operation
 *   cannot proceed because there is nowhere to anchor it.
 */
export function resolveUserHome(): string | null {
  const v = process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
