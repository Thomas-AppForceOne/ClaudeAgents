/**
 * YAML block parser for stack and overlay markdown files.
 *
 * Stack and overlay files are markdown documents with a YAML "frontmatter"
 * block delimited by `---` lines. This parser splits the document into three
 * pieces — the prose before the YAML block, the YAML body, and the prose
 * after — and parses the body via the `yaml` package (pinned `^2`).
 *
 * Round-trip property: `prose.before + reSerializedYamlBlock + prose.after`
 * must reconstitute the original document byte-for-byte when the parsed
 * data is unchanged. To satisfy this for arbitrary marker formatting (e.g.
 * `---\n`, `---  \n`, CRLF), the marker lines themselves are recorded in
 * the parse result and re-emitted verbatim by `serializeYamlBlock` when the
 * data argument is the same reference as the parsed `data`. Callers
 * mutating data should pass a fresh value; that path canonicalises markers
 * to `---\n`.
 *
 * Errors are built via the central `errors.ts` factory:
 *  - `MissingFile` if the markdown source is empty.
 *  - `MalformedInput` if the opening or closing `---` marker is missing.
 *  - `InvalidYAML` if the body fails to parse.
 */

import YAML from 'yaml';

import { createError } from '../errors.js';

export interface YamlBlockProse {
  /** Everything before the opening `---` line, including any trailing newline. */
  before: string;
  /** Everything after the closing `---` line, including its leading newline. */
  after: string;
}

export interface ParsedYamlBlock {
  /** Parsed YAML body. `null` for an empty block. */
  data: unknown;
  /** Prose flanking the YAML block (markers excluded). */
  prose: YamlBlockProse;
  /** Original YAML body text (between the markers, exclusive). */
  raw: string;
  /**
   * The exact opening marker line as found in the source, including its
   * trailing newline (e.g. `"---\n"`, `"---  \r\n"`).
   */
  openMarker: string;
  /**
   * The exact closing marker line as found in the source, including its
   * trailing newline (or empty string if the file ended without a newline
   * after the closing marker).
   */
  closeMarker: string;
}

/**
 * Locate and parse the YAML frontmatter block in a markdown source string.
 *
 * The block is identified by:
 *  - an opening line consisting solely of `---` (optionally with trailing
 *    whitespace), at the very start of the document or immediately after
 *    leading blank/prose lines;
 *  - a closing line consisting solely of `---`.
 *
 * @throws ConfigServerError(MissingFile) when `text` is empty.
 * @throws ConfigServerError(MalformedInput) when block markers are missing.
 * @throws ConfigServerError(InvalidYAML) when the body fails to parse.
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

  // Body starts immediately after the opening marker line.
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

  // Raw body: everything between (after) the opening marker line and the
  // closing marker's start (exclusive of the closing marker line itself).
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

interface MarkerLocation {
  /** Byte offset of the start of the marker line. */
  lineStart: number;
  /** Byte offset of the first character after the marker line's newline. */
  lineEnd: number;
}

/**
 * Find the next `---` marker line at or after `from`. A marker line consists
 * solely of three hyphens, optionally followed by whitespace, terminated by a
 * newline (or EOF). Returns `null` if no marker is found.
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
      // `lineEnd` index points to '\n' (or EOF). Advance past the newline so
      // the next slice begins on the next line.
      const advanced = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      return { lineStart: cursor, lineEnd: advanced };
    }
    if (lineEnd >= text.length) break;
    cursor = lineEnd + 1;
  }
  return null;
}

function isMarkerLine(line: string): boolean {
  // Trim a trailing CR for CRLF input, but otherwise reject any non-whitespace
  // content beyond the three hyphens. The marker MUST be exactly `---` plus
  // optional trailing whitespace; YAML does not accept trailing tokens.
  let trimmed = line;
  if (trimmed.endsWith('\r')) trimmed = trimmed.slice(0, -1);
  if (!trimmed.startsWith('---')) return false;
  const rest = trimmed.slice(3);
  return /^\s*$/.test(rest);
}

/**
 * Re-serialise a YAML block.
 *
 * If `parsed` is provided and the data argument is the *same reference* as
 * `parsed.data`, the original bytes (markers + raw body) are emitted
 * verbatim — preserving round-trip exactness when the caller has not
 * mutated the data.
 *
 * Otherwise the block is rebuilt via `YAML.stringify` and wrapped with the
 * canonical `---\n` markers. Callers performing a write should pass a fresh
 * data value to opt into canonical formatting.
 */
export function serializeYamlBlock(data: unknown, parsed?: ParsedYamlBlock): string {
  if (parsed && data === parsed.data) {
    return `${parsed.openMarker}${parsed.raw}${parsed.closeMarker}`;
  }
  const body = data === null || data === undefined ? '' : YAML.stringify(data);
  return `---\n${body}---\n`;
}
