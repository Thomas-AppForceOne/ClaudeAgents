

/**
 * The CLI's single JSON-rendering helper.
 *
 * Every `--json` code path emits through here so machine-readable output is
 * deterministic: stable key ordering and stable formatting across runs, which
 * keeps golden-file tests and downstream diffs from churning on incidental
 * ordering. Routing all JSON through one function is the guarantee.
 */

import { stableStringify } from '../../config-server/determinism/index.js';

/**
 * Serialise `value` to the canonical JSON string the CLI emits under `--json`.
 *
 * Delegates to {@link stableStringify}, so object keys are emitted in a
 * deterministic order regardless of insertion order — the property callers
 * rely on for reproducible output.
 *
 * @param value any JSON-serialisable value; non-JSON values (functions,
 *   `undefined`, circular references) follow `stableStringify`'s handling, so
 *   callers must pass plain config-shaped data.
 * @returns the serialised JSON string (no trailing newline added here).
 */
export function emitJson(value: unknown): string {
  return stableStringify(value);
}
