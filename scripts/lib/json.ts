/**
 * Deterministic JSON serialisation for the `scripts/` CLIs.
 *
 * Re-export only: the canonical implementation lives in the config-server's
 * determinism module, and the scripts re-export it from here so they import a
 * single stable form rather than reaching across the source tree. Routing it
 * through one place keeps every script's JSON output byte-identical, which is
 * what lets golden-file and schema-drift checks compare emitted bytes directly.
 */
export { stableStringify } from '../../src/config-server/determinism/index.js';
