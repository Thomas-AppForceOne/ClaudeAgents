

import { serializeYamlBlock, type ParsedYamlBlock } from './yaml-block-parser.js';

export interface WriteYamlBlockInput {

  originalSource: string;

  originalParse: ParsedYamlBlock;

  newData: unknown;
}

export function writeYamlBlock(input: WriteYamlBlockInput): string {
  const { originalSource, originalParse, newData } = input;

  if (deepEqual(newData, originalParse.data)) {

    return originalSource;
  }

  const yamlBlock = serializeYamlBlock(newData);
  return originalParse.prose.before + yamlBlock + originalParse.prose.after;
}

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
