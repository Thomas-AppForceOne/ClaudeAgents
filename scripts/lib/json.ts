/**
 * Stable JSON serialiser re-export.
 *
 * Per the centralised determinism rule (PROJECT_CONTEXT.md, R1-locked),
 * sorted-key two-space-indent JSON output is implemented exactly once at
 * `src/config-server/determinism/`. Maintainer scripts that emit JSON for
 * downstream tooling (`--json`) re-export the same function so the
 * canonical shape stays in one place.
 *
 * Anti-criterion AN5 forbids `JSON.stringify` inside `scripts/lib/` and
 * `scripts/lint-stacks/`. Importing from here is the only sanctioned
 * path.
 */
export { stableStringify } from '../../src/config-server/determinism/index.js';
