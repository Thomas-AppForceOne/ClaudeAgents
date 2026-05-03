/**
 * R3 sprint 2 — single-call-site JSON emitter.
 *
 * Every `--json` output in the CLI flows through `emitJson`. The function
 * is a thin wrapper over R1's `stableStringify` (sorted keys at every depth,
 * two-space indent, trailing newline per F3 determinism). This file does NOT
 * implement its own sort: re-implementing the F3 pin elsewhere is a
 * regression and is enforced by the targeted "single-implementation" check
 * in the sprint contract (`grep -rE "\.sort\(\) " src/cli/lib/json-output.ts`
 * must be empty).
 *
 * The wrapper exists so the CLI layer has a stable name to import (and so
 * future surface — e.g. a `--json-compact` mode — has one place to live);
 * the underlying serialisation is the determinism-pin'd implementation.
 */

import { stableStringify } from '../../config-server/determinism/index.js';

/**
 * Serialise `value` deterministically for a `--json` emission.
 *
 * Output contract:
 *   - keys sorted lexicographically at every depth;
 *   - two-space indent;
 *   - trailing newline.
 *
 * Round-trip property: `JSON.parse(emitJson(x))` then `emitJson(<that>)`
 * yields a byte-identical string. The CLI's `tests/cli/json-output.test.ts`
 * verifies this across 100 invocations.
 */
export function emitJson(value: unknown): string {
  return stableStringify(value);
}
