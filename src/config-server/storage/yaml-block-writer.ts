/**
 * YAML-block writer.
 *
 * Pairs with `yaml-block-parser.ts` to produce a byte-identical re-emit
 * when the YAML data is unchanged, and to splice new YAML content back
 * into the original prose when it is changed.
 *
 * Algorithm:
 *
 *  1. Caller hands us `{originalSource, originalParse, newData}`.
 *  2. We compare `newData` to `originalParse.data` by **structural
 *     equality**. If equal, we return `originalSource` byte-for-byte —
 *     this preserves any non-canonical YAML formatting the user had
 *     (comments, alternate quote styles, indentation choices) when the
 *     data did not actually change.
 *  3. If the data changed, we re-serialise the YAML body via
 *     `yaml.stringify` with the canonical `---\n` markers, and emit
 *     `prose.before + canonicalYamlBlock + prose.after`. Prose is
 *     preserved byte-identically; only the YAML region is regenerated.
 *
 * The compare-by-equality step is critical: a write tool that loads,
 * mutates, and re-writes must not perturb the file when the requested
 * mutation was a no-op (e.g. `setOverlayField` to the same value the file
 * already held). The byte-identical guarantee falls out of step 2.
 */

import { serializeYamlBlock, type ParsedYamlBlock } from './yaml-block-parser.js';

export interface WriteYamlBlockInput {
  /** The full original source bytes. */
  originalSource: string;
  /** The parse result for `originalSource` (from `parseYamlBlock`). */
  originalParse: ParsedYamlBlock;
  /** The new YAML body. May be the same reference as `originalParse.data`. */
  newData: unknown;
}

/**
 * Re-emit a markdown source with a (possibly mutated) YAML body. Returns
 * the original source byte-for-byte when `newData` is structurally equal
 * to `originalParse.data`. Otherwise returns
 * `prose.before + canonical YAML block + prose.after`.
 */
export function writeYamlBlock(input: WriteYamlBlockInput): string {
  const { originalSource, originalParse, newData } = input;

  if (deepEqual(newData, originalParse.data)) {
    // Unchanged: emit exact original bytes, including any non-canonical
    // marker formatting (e.g. trailing whitespace on `---  `).
    return originalSource;
  }

  // Changed: re-serialise the YAML block via the canonical writer (which
  // emits `---\n<body>---\n`). Prose flanks are preserved byte-identically.
  const yamlBlock = serializeYamlBlock(newData);
  return originalParse.prose.before + yamlBlock + originalParse.prose.after;
}

/**
 * Structural equality for YAML-shaped data. Handles plain objects, arrays,
 * primitives, and `null` / `undefined`. Object comparison is order-
 * independent — `{a: 1, b: 2}` equals `{b: 2, a: 1}`. This matches the
 * semantic intent: "did the data change", not "did the JSON-text change".
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}
