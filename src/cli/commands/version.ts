/**
 * R3 sprint 1 — `gan version`.
 *
 * Reads:
 *   - apiVersion via R1's `getApiVersion()` library entry (in-process call,
 *     per the CLI-imports-library rule).
 *   - serverVersion (the framework's package version) from `package.json`.
 *   - schemas: every `<type>-vN.json` file under the package's `schemas/`
 *     directory, sorted under F3's locale-sensitive sort.
 *
 * On `--json`, emits a single sorted-key, two-space-indent, trailing-newline
 * JSON document on stdout (per F3 determinism + the round-trip rule).
 *
 * If the framework library cannot be reached — `getApiVersion()` throws or
 * `package.json` is unreadable — the command exits 5 with a remediation
 * pointer to `install.sh`. This satisfies F-AC6 of the R3 spec.
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getApiVersion } from '../../config-server/index.js';
import { localeSort, stableStringify } from '../../config-server/determinism/index.js';
import { createError } from '../../config-server/errors.js';
import { EXIT_API_UNREACHABLE, EXIT_OK } from '../lib/exit-codes.js';
import type { ParsedArgs } from '../lib/args.js';

export interface VersionOutput {
  apiVersion: string;
  serverVersion: string;
  schemas: Array<{ name: string; version: number }>;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Locate the framework's package root. From
 * `dist/cli/commands/version.js` this is three levels up
 * (`commands/` → `cli/` → `dist/` → `<root>`). Same shape from
 * `src/cli/commands/version.ts` under vitest.
 */
function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), '..', '..', '..');
}

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
  // Deterministic order: locale-sensitive sort by the file name, then drop `raw`.
  const sorted = localeSort(matched.map((x) => x.raw));
  return sorted.map((raw) => {
    const found = matched.find((x) => x.raw === raw)!;
    return { name: found.name, version: found.version };
  });
}

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
 * Run `gan version`. Always returns a `CommandResult`; never throws. The
 * dispatcher writes stdout/stderr and exits with `code`.
 */
export async function run(parsed: ParsedArgs): Promise<CommandResult> {
  const wantJson = parsed.flags['json'] === true;
  try {
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
