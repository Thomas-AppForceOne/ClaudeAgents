

/**
 * Read-side loader for stack files (the read counterpart to the stack write
 * tools in `tools/writes.ts`).
 *
 * A "stack" is a named, tiered config document (project tier overriding the
 * packaged default); resolution to a concrete file is delegated to the
 * stack-resolution layer. This module reads the resolved file, parses its YAML
 * block, and — in the validating variant — checks it against the stack schema.
 *
 * Error posture mirrors the overlay loader: {@link loadStack} THROWS on a
 * resolution or parse failure, whereas {@link loadStackWithValidation} catches a
 * `ConfigServerError` and returns it (with any schema issues) as data, so a
 * caller can present all problems at once. Unlike overlays, a stack always
 * resolves to a file or fails — there is no "absent stack returns null" state in
 * the throwing loader.
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

/**
 * A loaded stack document.
 *
 * @property data the parsed YAML body (any shape); not schema-validated by
 *   {@link loadStack}.
 * @property prose the Markdown surrounding the YAML block, preserved for
 *   round-tripping writes.
 * @property sourceTier which tier the resolved file came from.
 * @property sourcePath absolute path the stack was read from.
 * @property raw the raw YAML block text.
 */
export interface LoadedStack {

  data: unknown;

  prose: YamlBlockProse;

  sourceTier: StackTier;

  sourcePath: string;

  raw: string;
}

/**
 * Resolve, read, and parse stack `name` without schema validation.
 *
 * @param name the stack name to resolve.
 * @param projectRoot the project directory (project tier wins over the packaged
 *   default).
 * @param opts stack-resolution options (e.g. `userHome`, `packageRoot`).
 * @returns the {@link LoadedStack}.
 * @throws `ConfigServerError` when the stack cannot be resolved (e.g.
 *   `UnknownStack`, `MissingFile`) or its YAML block is missing/invalid; a read
 *   error on the resolved file also propagates.
 */
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
 * Load stack `name` and validate it against the stack schema, collecting
 * problems as data rather than throwing.
 *
 * @param name the stack name.
 * @param projectRoot the project directory.
 * @param opts stack-resolution options.
 * @returns `{ loaded, issues }`. On a caught `ConfigServerError`, `loaded` is
 *   `null` and `issues` carries the error; otherwise `loaded` is the stack and
 *   `issues` holds any schema-validation issues (empty means valid).
 * @throws only re-throws a non-`ConfigServerError` fault; expected
 *   resolution/parse errors are returned in `issues`.
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
    // Expected resolution/parse failures become returned issues; any other
    // throw is an unexpected fault and must propagate.
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
