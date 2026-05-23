

/**
 * Parse a "YAML block" document: a `---`-delimited YAML body embedded in
 * surrounding Markdown prose, the on-disk format for overlays and stacks.
 *
 * The parser splits a file into three parts — prose before the opening `---`,
 * the YAML body between the markers, and prose after the closing `---` — and
 * parses only the body. The surrounding prose and the exact marker lines are
 * preserved so a later write (see yaml-block-writer) can reconstruct the file
 * with the user's prose, comments, and formatting intact, rewriting only the
 * YAML. Byte offsets, not line splitting, are used throughout so the
 * round-trip is exact (including original line endings).
 */
import YAML from 'yaml';

import { createError } from '../errors.js';

/**
 * The non-YAML text surrounding the block, preserved for round-tripping.
 *
 * @property before everything up to (excluding) the opening `---` line.
 * @property after everything from after the closing `---` line to end of file.
 */
export interface YamlBlockProse {

  before: string;

  after: string;
}

/**
 * The result of parsing a YAML-block document.
 *
 * @property data the parsed YAML body (any YAML value, including `null` for an
 *   empty body).
 * @property prose the surrounding prose (see {@link YamlBlockProse}).
 * @property raw the exact body text between the markers (unparsed).
 * @property openMarker the exact opening marker line (including its newline).
 * @property closeMarker the exact closing marker line.
 */
export interface ParsedYamlBlock {

  data: unknown;

  prose: YamlBlockProse;

  raw: string;

  openMarker: string;

  closeMarker: string;
}

/**
 * Parse `text` as a YAML-block document.
 *
 * @param text the full file contents.
 * @param filePath optional path, used only to make error messages name the
 *   file; parsing does not read it.
 * @returns the {@link ParsedYamlBlock} with body and surrounding prose split out.
 *
 * Failure modes (all THROWN as `ConfigServerError`, never returned):
 * - empty `text` → code `MissingFile`;
 * - no opening or no closing `---` marker → code `MalformedInput`;
 * - a present body that is not valid YAML → code `InvalidYAML`, carrying the
 *   `line`/`column` of the first parse error when the YAML library reports it.
 */
export function parseYamlBlock(text: string, filePath?: string): ParsedYamlBlock {
  if (text.length === 0) {
    throw createError('MissingFile', {
      file: filePath,
      message: filePath
        ? `File '${filePath}' is empty; expected a YAML block delimited by --- markers.`
        : 'Source is empty; expected a YAML block delimited by --- markers.',
    });
  }

  const openIdx = findMarker(text, 0);
  if (openIdx === null) {
    throw createError('MalformedInput', {
      file: filePath,
      message: filePath
        ? `File '${filePath}' is missing the opening '---' YAML marker.`
        : "Source is missing the opening '---' YAML marker.",
    });
  }

  const bodyStart = openIdx.lineEnd;
  const closeIdx = findMarker(text, bodyStart);
  if (closeIdx === null) {
    throw createError('MalformedInput', {
      file: filePath,
      message: filePath
        ? `File '${filePath}' is missing the closing '---' YAML marker.`
        : "Source is missing the closing '---' YAML marker.",
    });
  }

  const raw = text.slice(bodyStart, closeIdx.lineStart);

  const before = text.slice(0, openIdx.lineStart);
  const after = text.slice(closeIdx.lineEnd);
  const openMarker = text.slice(openIdx.lineStart, openIdx.lineEnd);
  const closeMarker = text.slice(closeIdx.lineStart, closeIdx.lineEnd);

  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (e) {
    const err = e as { message?: string; linePos?: Array<{ line: number; col: number }> };
    const linePos = Array.isArray(err.linePos) && err.linePos.length > 0 ? err.linePos[0] : null;
    throw createError('InvalidYAML', {
      file: filePath,
      line: linePos?.line,
      column: linePos?.col,
      message: filePath
        ? `Invalid YAML in '${filePath}': ${err.message ?? 'parse error'}`
        : `Invalid YAML: ${err.message ?? 'parse error'}`,
    });
  }

  return {
    data,
    prose: { before, after },
    raw,
    openMarker,
    closeMarker,
  };
}

/**
 * Byte offsets of a marker line within the source.
 *
 * @property lineStart offset of the first character of the marker line.
 * @property lineEnd offset just past the marker line's terminating newline (or
 *   end of text if the marker is the last line). Slicing on these offsets keeps
 *   the surrounding prose and body exact, including line endings.
 */
interface MarkerLocation {

  lineStart: number;

  lineEnd: number;
}

/**
 * Scan forward from offset `from` for the next `---` marker line.
 *
 * Walks line by line by `\n` offsets (so it never allocates an array of all
 * lines and the returned offsets index straight into `text`). The final line
 * may lack a trailing newline, hence the `lineEnd === text.length` handling.
 *
 * @returns the marker's {@link MarkerLocation}, or `null` if none is found.
 */
function findMarker(text: string, from: number): MarkerLocation | null {
  let cursor = from;
  while (cursor <= text.length) {
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1) {
      lineEnd = text.length;
    }
    const line = text.slice(cursor, lineEnd);
    if (isMarkerLine(line)) {
      // Include the trailing newline in the marker span when present, so the
      // body/prose slices fall on clean line boundaries.
      const advanced = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      return { lineStart: cursor, lineEnd: advanced };
    }
    if (lineEnd >= text.length) break;
    cursor = lineEnd + 1;
  }
  return null;
}

/**
 * Whether `line` is a YAML-block marker: `---` optionally followed by only
 * whitespace. A trailing `\r` is tolerated (CRLF files), and trailing
 * whitespace after `---` is allowed so the parser is not brittle to editors
 * that leave it.
 */
function isMarkerLine(line: string): boolean {

  let trimmed = line;
  if (trimmed.endsWith('\r')) trimmed = trimmed.slice(0, -1);
  if (!trimmed.startsWith('---')) return false;
  const rest = trimmed.slice(3);
  return /^\s*$/.test(rest);
}

/**
 * Serialise a YAML body back into `---`-delimited block form.
 *
 * @param data the YAML value to serialise.
 * @param parsed optional original parse. When provided AND `data` is the *same
 *   object reference* as `parsed.data`, the original raw body and exact marker
 *   lines are reused verbatim — an unmodified document round-trips byte-for-byte
 *   rather than being reformatted by the YAML serialiser.
 * @returns the block text. When `data` is `null`/`undefined`, an empty body
 *   between fresh `---` markers is produced.
 */
export function serializeYamlBlock(data: unknown, parsed?: ParsedYamlBlock): string {
  if (parsed && data === parsed.data) {
    return `${parsed.openMarker}${parsed.raw}${parsed.closeMarker}`;
  }
  const body = data === null || data === undefined ? '' : YAML.stringify(data);
  return `---\n${body}---\n`;
}
