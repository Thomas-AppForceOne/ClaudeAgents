/**
 * Regression guard for the install-affecting minor version bump.
 *
 * The version-bump discipline requires a minor bump whenever an
 * install-affecting change ships (new schema fields, new MCP tool,
 * additive run-trace-v1 / overlay-v1 surface). Without a guarded version
 * field, a subsequent diff could silently revert the bump or forget to
 * roll it forward, and `install.sh`'s version-probe (which triggers
 * reinstall on mismatch) would diverge from the published package
 * contract.
 *
 * The expected value is hard-coded here on purpose: this test is the
 * "ratchet" — when the next install-affecting change lands the test must
 * be intentionally updated in the same diff, surfacing the version
 * decision in code review rather than leaving it implicit.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read the top-level `package.json` and return the parsed shape.
 *
 * Isolated so the file-read failure surfaces with a single readable path
 * rather than as a stack from inside an assertion.
 */
function loadPackageJson(): { version: unknown } {
  const abs = path.join(REPO_ROOT, 'package.json');
  return JSON.parse(readFileSync(abs, 'utf8')) as { version: unknown };
}

describe('package.json version field carries the install-affecting minor bump', () => {
  it('top-level version is exactly the string 0.7.0', () => {
    const pkg = loadPackageJson();
    // String-typed comparison is deliberate: the field is documented as a
    // semver string, and a numeric coercion would mask a future regression
    // that wrote `0.7` (no patch component) instead of `0.7.0`.
    expect(pkg.version).toBe('0.7.0');
  });
});
