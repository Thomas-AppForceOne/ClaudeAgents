/**
 * Stack file loader.
 *
 * Resolves a stack name through C5's three-tier resolver, reads the file
 * from disk, and parses the YAML frontmatter block. Returns the parsed
 * data, the prose flanking the block, and the source tier + path for
 * provenance. The loader does **not** merge across tiers — wholesale
 * replacement is a C5 invariant.
 *
 * Errors propagate from `resolveStackFile` (`MissingFile`) and
 * `parseYamlBlock` (`InvalidYAML` / `MalformedInput`).
 */

import { readFileSync } from 'node:fs';

import {
  resolveStackFile,
  type ResolveStackOptions,
  type StackTier,
} from '../resolution/stack-resolution.js';
import { parseYamlBlock, type YamlBlockProse } from './yaml-block-parser.js';

export interface LoadedStack {
  /** Parsed YAML body (typically an object). */
  data: unknown;
  /** Prose flanking the YAML block. */
  prose: YamlBlockProse;
  /** Tier the resolved file came from. */
  sourceTier: StackTier;
  /** Absolute path to the resolved stack file. */
  sourcePath: string;
  /** Raw original YAML body bytes (for round-trip writes). */
  raw: string;
}

export function loadStack(
  name: string,
  projectRoot: string,
  opts: ResolveStackOptions = {},
): LoadedStack {
  const resolved = resolveStackFile(name, projectRoot, opts);
  const text = readFileSync(resolved.path, 'utf8');
  const parsed = parseYamlBlock(text, resolved.path);
  return {
    data: parsed.data,
    prose: parsed.prose,
    sourceTier: resolved.tier,
    sourcePath: resolved.path,
    raw: parsed.raw,
  };
}
