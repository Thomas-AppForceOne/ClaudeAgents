/**
 * R-post sprint 6 — `gan stacks available [--json]`.
 *
 * Lists every built-in stack file the framework ships at
 * `<packageRoot>/stacks/`. "Available" is distinct from "active" (`gan
 * stacks list`, which reports stacks whose detection rules currently match
 * the host project) and from "installed" (a customisation copied into a
 * higher tier via `gan stacks customize`). See the R3 spec's "Active vs.
 * available vs. installed" paragraph for the full distinction.
 *
 * Output:
 *   - human: `NAME  VERSION  DESCRIPTION` table with a header row, two-space
 *     gaps between columns, one row per `*.md` file. Empty directory prints
 *     `(no built-in stacks)`.
 *   - JSON: `{"stacks": [{description, name, path, schemaVersion}, ...]}`
 *     emitted via `emitJson` (sorted keys, two-space indent, trailing newline).
 *
 * Errors:
 *   - missing built-in directory → `MissingFile`, exit 2 (validation bucket).
 *   - parse failures on individual files are tolerated: the offending entry
 *     is skipped, with a one-line warning routed to stderr (so callers
 *     scripting against `--json` still see an empty / partial list and exit 0).
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

interface AvailableStack {
  description: string;
  name: string;
  path: string;
  schemaVersion: number;
}

/**
 * Resolve the built-in stacks directory. Reads
 * `process.env.GAN_PACKAGE_ROOT_OVERRIDE` first as a test seam; otherwise
 * walks up from `import.meta.url` via the shared `packageRoot()` helper.
 *
 * @internal test-only env var: `GAN_PACKAGE_ROOT_OVERRIDE`. Tests inject a
 *   tmp directory so they can stage a fixture stacks/ tree without touching
 *   the published package layout. Production callers leave it unset.
 */
function resolveBuiltinStacksDir(): string {
  const override = process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  const root =
    typeof override === 'string' && override.length > 0 ? override : resolvePackageRoot();
  return path.join(root, 'stacks');
}

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

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

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

export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const { wantJson } = readSharedFlags(parsed);

  let stacksDir: string;
  try {
    stacksDir = resolveBuiltinStacksDir();
  } catch (e) {
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
      warnings.push(`warning: skipped unreadable or malformed stack file: ${abs}\n`);
      continue;
    }
    stacks.push(entry);
  }

  // Sort the parsed stacks by `name` for stable output (independent of file
  // sort order — built-in `name` may differ from the file's basename).
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
