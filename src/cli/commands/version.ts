

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
