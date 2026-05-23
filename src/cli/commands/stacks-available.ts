/**
 * `gan stacks available` — list the framework's built-in stacks, read straight
 * off disk from the installed package's `stacks/` directory.
 *
 * This is a project-independent inventory: it does not resolve a project root
 * or apply overlays. Individual stack files that cannot be read or parsed are
 * skipped with a `stderr` warning rather than failing the whole command, so a
 * single malformed built-in never hides the rest; only the *absence* of the
 * stacks directory itself is a hard error.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { localeSort } from '../../config-server/determinism/index.js';
import { ConfigServerError, createError } from '../../config-server/errors.js';
import { packageRoot as resolvePackageRoot } from '../../config-server/package-root.js';
import { parseYamlBlock } from '../../config-server/storage/yaml-block-parser.js';
import { renderError, renderErrorJson } from '../lib/errors.js';
import { emitJson } from '../lib/json-output.js';
import { EXIT_OK, exitCodeFor } from '../lib/exit-codes.js';
import { readSharedFlags, type CommandResult } from '../lib/run-helpers.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * One built-in stack as surfaced to the caller.
 *
 * @property description the stack's `description` field, or `''` when absent.
 * @property name the stack's declared `name` (required to be listed).
 * @property path absolute path to the stack's `.md` file on disk.
 * @property schemaVersion the declared `schemaVersion` (required to be listed).
 */
interface AvailableStack {
  description: string;
  name: string;
  path: string;
  schemaVersion: number;
}

/**
 * Resolve the absolute path of the installed package's built-in `stacks/`
 * directory.
 *
 * Honours the `GAN_PACKAGE_ROOT_OVERRIDE` env var (used by tests to point at a
 * fixture install) before falling back to the real package-root resolver.
 *
 * @returns the `<package-root>/stacks` path; never null (existence is checked
 *   by the caller). May throw if the underlying package-root resolver throws.
 */
function resolveBuiltinStacksDir(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  const root =
    typeof override === 'string' && override.length > 0 ? override : resolvePackageRoot();
  return path.join(root, 'stacks');
}

/**
 * List the `.md` filenames in the stacks directory, locale-sorted for
 * deterministic ordering.
 *
 * @param stacksDir absolute path to the built-in stacks directory.
 * @returns the sorted `.md` filenames, or `null` when the directory is absent,
 *   is not a directory, or cannot be read — every failure collapses to `null`
 *   so the caller can map a missing directory to a single hard error.
 */
function readDirectoryEntries(stacksDir: string): string[] | null {
  if (!existsSync(stacksDir)) return null;
  let entries: string[];
  try {
    const st = statSync(stacksDir);
    if (!st.isDirectory()) return null;
    entries = readdirSync(stacksDir);
  } catch {
    return null;
  }
  const mdFiles = entries.filter((e) => e.endsWith('.md'));
  return localeSort(mdFiles);
}

/**
 * Parse one stack file into an {@link AvailableStack}.
 *
 * @param filePath absolute path to a candidate stack `.md` file.
 * @returns the parsed entry, or `null` if the file is unreadable, has invalid
 *   YAML, is not a mapping, or is missing the required string `name` /
 *   numeric `schemaVersion`. All failures are returned (never thrown) so the
 *   caller can skip-with-warning rather than abort the listing.
 */
function parseEntry(filePath: string): AvailableStack | null {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = parseYamlBlock(text, filePath);
  } catch {
    return null;
  }
  if (parsed.data === null || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
    return null;
  }
  const data = parsed.data as Record<string, unknown>;
  const name = typeof data.name === 'string' ? data.name : null;
  const schemaVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : null;
  if (name === null || schemaVersion === null) return null;
  const description = typeof data.description === 'string' ? data.description : '';
  return { description, name, path: filePath, schemaVersion };
}

/**
 * Right-pad `s` with spaces to at least `width` columns (used for table
 * alignment); returns `s` unchanged when already wide enough.
 */
function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

/**
 * Render the built-in stacks as a fixed-width NAME/VERSION/DESCRIPTION table
 * for human (non-JSON) output. Column widths are sized to the longest cell so
 * rows align.
 *
 * @param stacks the stacks to render, already sorted by the caller.
 * @returns the table text with a trailing newline, or `(no built-in stacks)\n`
 *   when the list is empty.
 */
function renderHumanTable(stacks: readonly AvailableStack[]): string {
  if (stacks.length === 0) return '(no built-in stacks)\n';
  const headers = { name: 'NAME', version: 'VERSION', description: 'DESCRIPTION' };
  let nameWidth = headers.name.length;
  let versionWidth = headers.version.length;
  for (const s of stacks) {
    if (s.name.length > nameWidth) nameWidth = s.name.length;
    const v = String(s.schemaVersion);
    if (v.length > versionWidth) versionWidth = v.length;
  }
  const lines: string[] = [];
  lines.push(
    `${padRight(headers.name, nameWidth)}  ${padRight(headers.version, versionWidth)}  ${headers.description}`,
  );
  for (const s of stacks) {
    lines.push(
      `${padRight(s.name, nameWidth)}  ${padRight(String(s.schemaVersion), versionWidth)}  ${s.description}`,
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan stacks available`.
 *
 * Honours `--json` (project-root is irrelevant here — built-ins are global).
 *
 * @param parsed parsed argv.
 * @returns a {@link CommandResult}. On success, exit OK with the listing on
 *   `stdout` and any per-file skip warnings on `stderr`. Failure modes are
 *   returned as data (never thrown): a package-root resolution error or a
 *   missing/unreadable stacks directory becomes a `MissingFile`-class error
 *   with its mapped exit code.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson } = readSharedFlags(parsed);

  let stacksDir: string;
  try {
    stacksDir = resolveBuiltinStacksDir();
  } catch (e) {
    // Normalise any non-ConfigServerError into a MissingFile so the caller-
    // facing failure shape is uniform regardless of how resolution broke.
    const err =
      e instanceof ConfigServerError
        ? e
        : createError('MissingFile', {
            message: `the framework could not locate its built-in stacks directory: ${
              e instanceof Error ? e.message : String(e)
            }`,
          });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: exitCodeFor(err.code) };
    return { stdout: '', stderr: renderError(err), code: exitCodeFor(err.code) };
  }

  const entries = readDirectoryEntries(stacksDir);
  if (entries === null) {
    const err = createError('MissingFile', {
      file: stacksDir,
      message: `the framework's built-in stacks directory does not exist: ${stacksDir}`,
    });
    if (wantJson) return { stdout: renderErrorJson(err), stderr: '', code: exitCodeFor(err.code) };
    return { stdout: '', stderr: renderError(err), code: exitCodeFor(err.code) };
  }

  const stacks: AvailableStack[] = [];
  const warnings: string[] = [];
  for (const fileName of entries) {
    const abs = path.join(stacksDir, fileName);
    const entry = parseEntry(abs);
    if (entry === null) {
      // Skip-with-warning: one bad built-in stack must not hide the others.
      warnings.push(`warning: skipped unreadable or malformed stack file: ${abs}\n`);
      continue;
    }
    stacks.push(entry);
  }

  // Sort by declared name (not filename): the directory scan was sorted by
  // filename, but the user-facing ordering keys on the stack's own `name`.
  const sorted = stacks
    .slice()
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'variant', numeric: false }),
    );

  if (wantJson) {
    return { stdout: emitJson({ stacks: sorted }), stderr: warnings.join(''), code: EXIT_OK };
  }
  return { stdout: renderHumanTable(sorted), stderr: warnings.join(''), code: EXIT_OK };
}
