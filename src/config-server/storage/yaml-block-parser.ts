

import YAML from 'yaml';

import { createError } from '../errors.js';

export interface YamlBlockProse {

  before: string;

  after: string;
}

export interface ParsedYamlBlock {

  data: unknown;

  prose: YamlBlockProse;

  raw: string;

  openMarker: string;

  closeMarker: string;
}

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

interface MarkerLocation {

  lineStart: number;

  lineEnd: number;
}

function findMarker(text: string, from: number): MarkerLocation | null {
  let cursor = from;
  while (cursor <= text.length) {
    let lineEnd = text.indexOf('\n', cursor);
    if (lineEnd === -1) {
      lineEnd = text.length;
    }
    const line = text.slice(cursor, lineEnd);
    if (isMarkerLine(line)) {

      const advanced = lineEnd < text.length ? lineEnd + 1 : lineEnd;
      return { lineStart: cursor, lineEnd: advanced };
    }
    if (lineEnd >= text.length) break;
    cursor = lineEnd + 1;
  }
  return null;
}

function isMarkerLine(line: string): boolean {

  let trimmed = line;
  if (trimmed.endsWith('\r')) trimmed = trimmed.slice(0, -1);
  if (!trimmed.startsWith('---')) return false;
  const rest = trimmed.slice(3);
  return /^\s*$/.test(rest);
}

export function serializeYamlBlock(data: unknown, parsed?: ParsedYamlBlock): string {
  if (parsed && data === parsed.data) {
    return `${parsed.openMarker}${parsed.raw}${parsed.closeMarker}`;
  }
  const body = data === null || data === undefined ? '' : YAML.stringify(data);
  return `---\n${body}---\n`;
}
