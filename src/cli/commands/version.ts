/**
 * `gan version` — report the API version, the server (package) version, and
 * the schemas present on disk.
 *
 * The three facts come from independent sources (the config-server API, the
 * package's `package.json`, and the `schemas/` directory), gathered
 * concurrently. Any failure in gathering is treated uniformly as "the
 * framework library is unreachable" — the user's actionable fix is always the
 * same (`install.sh`), so a single catch-all message and the
 * {@link EXIT_API_UNREACHABLE} code cover every fault.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getApiVersion } from '../../config-server/index.js';
import { localeSort, stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { EXIT_API_UNREACHABLE, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

/**
 * Reported version triple.
 *
 * @property apiVersion the config-server API version string.
 * @property serverVersion the installed package version (from `package.json`).
 * @property schemas the schemas discovered on disk, each as a `name`/`version`
 *   pair, ordered deterministically by filename.
 */
export interface VersionOutput {
  apiVersion: string;
  serverVersion: string;
  schemas: Array<{ name: string; version: number }>;
}

/**
 * Result contract shared by every CLI command handler.
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Resolve the installed package root relative to this compiled module.
 *
 * The `../../..` climb is anchored to this file's location after compilation
 * (three levels up from `dist/cli/commands/`), not to the process cwd, so the
 * lookup is correct regardless of where `gan` is invoked from.
 */
function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..', '..');
}

/**
 * Read the package version from `<package-root>/package.json`.
 *
 * @returns the `version` string.
 * @throws a `MalformedInput` {@link createError} when `version` is missing or
 *   not a string; the underlying `readFile`/`JSON.parse` also throw on a
 *   missing or invalid file. All such throws are caught by {@link run} and
 *   collapsed into the unreachable-library message.
 */
async function readServerVersion(): Promise<string> {
  const pkgPath = path.join(packageRoot(), 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== 'string') {
    throw createError('MalformedInput', {
      file: pkgPath,
      field: 'version',
      message: `package.json at ${pkgPath} is missing a string "version" field`,
    });
  }
  return parsed.version;
}

/**
 * Enumerate the schema files in `<package-root>/schemas/`.
 *
 * Only files matching `<name>-v<digits>.json` are reported; anything else in
 * the directory is ignored. A missing/unreadable directory yields `[]` (no
 * schemas is a valid state, not an error). Results are ordered by locale-sorted
 * filename for determinism, then projected to `name`/`version` pairs.
 *
 * @returns the discovered schemas; never throws.
 */
async function enumerateSchemas(): Promise<Array<{ name: string; version: number }>> {
  const dir = path.join(packageRoot(), 'schemas');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const matched: Array<{ name: string; version: number; raw: string }> = [];
  const re = /^([a-z][a-z0-9-]*)-v(\d+)\.json$/;
  for (const e of entries) {
    const m = re.exec(e);
    if (!m) continue;
    matched.push({ name: m[1]!, version: Number(m[2]!), raw: e });
  }

  // Sort by filename (deterministic) and then look the parsed record back up,
  // so the emitted order matches the on-disk filename order exactly.
  const sorted = localeSort(matched.map((x) => x.raw));
  return sorted.map((raw) => {
    const found = matched.find((x) => x.raw === raw)!;
    return { name: found.name, version: found.version };
  });
}

/**
 * Render the version triple for human (non-JSON) output as aligned
 * `key: value` lines plus a `schemas:` block (`(none on disk)` when empty).
 *
 * @param out the gathered version info.
 * @returns the formatted text with a trailing newline.
 */
function renderHuman(out: VersionOutput): string {
  const lines: string[] = [];
  lines.push(`apiVersion:    ${out.apiVersion}`);
  lines.push(`serverVersion: ${out.serverVersion}`);
  lines.push('schemas:');
  if (out.schemas.length === 0) {
    lines.push('  (none on disk)');
  } else {
    for (const s of out.schemas) {
      lines.push(`  - ${s.name} v${s.version}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * CLI entrypoint for `gan version`.
 *
 * @param parsed parsed argv; honours `--json`. No project root is involved —
 *   version info is global to the install.
 * @returns a {@link CommandResult}. On success the triple is on `stdout` with
 *   exit {@link EXIT_OK}. Any failure in gathering the three facts is caught
 *   and reported as the library being unreachable: a fixed `install.sh` hint
 *   on `stderr` with exit {@link EXIT_API_UNREACHABLE}. Never throws.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
  try {
    // Gather the three independent facts concurrently; any rejection drops to
    // the single catch-all below.
    const [api, server, schemas] = await Promise.all([
      getApiVersion(),
      readServerVersion(),
      enumerateSchemas(),
    ]);
    const out: VersionOutput = {
      apiVersion: api.apiVersion,
      serverVersion: server,
      schemas,
    };
    const stdout = wantJson ? stableStringify(out) : renderHuman(out);
    return { stdout, stderr: '', code: EXIT_OK };
  } catch {
    const stderr =
      "Error: cannot reach the framework's library. " +
      "Run `install.sh` from the framework's repo root.\n";
    return { stdout: '', stderr, code: EXIT_API_UNREACHABLE };
  }
}
