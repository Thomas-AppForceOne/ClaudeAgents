

/**
 * Write an updated YAML body back into a parsed YAML-block document while
 * preserving the surrounding Markdown prose.
 *
 * This is the write counterpart to yaml-block-parser. Given the original source,
 * its parse, and a new YAML value, it re-emits only the YAML block between the
 * preserved `before`/`after` prose. A no-op write (new data deep-equal to the
 * original) returns the original source byte-for-byte, so persisting an
 * unchanged document never reformats it or churns the file.
 */
import { serializeYamlBlock, type ParsedYamlBlock } from './yaml-block-parser.js';

/**
 * Inputs to {@link writeYamlBlock}.
 *
 * @property originalSource the original full file contents.
 * @property originalParse the parse of `originalSource` (supplies the prose to
 *   preserve and the prior data for the change check).
 * @property newData the new YAML value to write into the block.
 */
export interface WriteYamlBlockInput {

  originalSource: string;

  originalParse: ParsedYamlBlock;

  newData: unknown;
}

/**
 * Produce the new file contents with `newData` serialised into the YAML block
 * and the original surrounding prose preserved.
 *
 * @param input see {@link WriteYamlBlockInput}.
 * @returns the new full source. When `newData` is deep-equal to the original
 *   parsed data, returns `originalSource` unchanged (byte-identical) — the value
 *   short-circuit that avoids reserialising an effectively-unmodified document.
 *   Pure; no I/O.
 */
export function writeYamlBlock(input: WriteYamlBlockInput): string {
  const { originalSource, originalParse, newData } = input;

  if (deepEqual(newData, originalParse.data)) {
    // No semantic change: return the original verbatim so an unchanged write
    // neither reformats the YAML nor disturbs the file's bytes.
    return originalSource;
  }

  const yamlBlock = serializeYamlBlock(newData);
  return originalParse.prose.before + yamlBlock + originalParse.prose.after;
}

/**
 * Structural deep equality for JSON-shaped YAML values (objects, arrays,
 * scalars). Used only to detect a no-op write. Compares arrays element-wise and
 * objects by same key set + recursively-equal values; key *order* does not
 * matter, so a reordered-but-equivalent mapping is correctly treated as
 * unchanged.
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
