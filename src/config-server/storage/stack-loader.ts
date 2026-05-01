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
 *
 * S3 also adds `loadStackWithValidation` — same loader, but ajv body-schema
 * validation runs after parse and any failures are returned as F2-shaped
 * issues alongside the loaded data instead of throwing. The validate
 * pipeline (`tools/validate.ts`) consumes this entry point.
 */

import { readFileSync } from 'node:fs';

import { ConfigServerError } from '../errors.js';
import {
  resolveStackFile,
  type ResolveStackOptions,
  type StackTier,
} from '../resolution/stack-resolution.js';
import { validateStackBodyAgainstSchema, type Issue } from '../validation/schema-check.js';
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

/**
 * Resolve + load + ajv-validate a stack file. On parse or schema failure,
 * returns issues alongside whatever data could be loaded; never throws
 * for `MissingFile` / `InvalidYAML` / `SchemaMismatch`. The validate
 * pipeline collects these issues across all discovered files.
 *
 * `MalformedInput` from a structurally bad input (e.g. missing markers)
 * is also folded into an issue rather than thrown, on the same principle.
 */
export function loadStackWithValidation(
  name: string,
  projectRoot: string,
  opts: ResolveStackOptions = {},
): { loaded: LoadedStack | null; issues: Issue[] } {
  const issues: Issue[] = [];
  let loaded: LoadedStack;
  try {
    loaded = loadStack(name, projectRoot, opts);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      issues.push({
        code: e.code,
        path: e.file ?? e.path,
        field: e.field,
        message: e.message,
        severity: 'error',
      });
      return { loaded: null, issues };
    }
    throw e;
  }
  validateStackBodyAgainstSchema(loaded.sourcePath, loaded.data, issues);
  return { loaded, issues };
}
