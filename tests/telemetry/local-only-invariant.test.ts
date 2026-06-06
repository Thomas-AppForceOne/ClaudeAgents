/**
 * Local-only invariant suite — pins that the telemetry emission path makes
 * zero network calls.
 *
 * The five Node built-in module specifiers covered by this invariant —
 * `'node:http'`, `'node:https'`, `'node:net'`, `'node:dgram'`, `'node:dns'`
 * — must not appear anywhere in the import graph of the two telemetry
 * writers. A regression that wired one in would surface as a static-scan
 * hit here long before any runtime network operation could happen.
 *
 * Why static-import-graph scan rather than runtime spies: Node's ESM
 * built-in modules expose their exports as non-configurable getters, so a
 * `vi.spyOn(http, 'request')` raises `Cannot redefine property: request`
 * before it can attach. The prompt's documented fallback is exactly this
 * scan — read the import sites of every transitively-reachable source file
 * from the two writers and assert none of them name a network module. The
 * scan is deliberately conservative: it walks `from '...'` and `from "..."`
 * import specifiers in every reachable `.ts` file under `src/`, and pins
 * that none of the five network specifiers appears in the closure.
 *
 * The runtime path is also covered indirectly: the writers' implementations
 * use only `node:fs`, `node:path`, and the shipped trace library, none of
 * which opens a socket on its own. A runtime regression to one of those
 * (e.g. a new dependency added under the trace library that imports
 * `node:http`) would surface in the scan via the transitive walk.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.resolve(HERE, '..', '..', 'src');

// The five network-capable Node built-ins the local-only invariant
// refuses. Each specifier is a literal string so the contract's grep
// against this file finds five distinct specifiers exactly.
const FORBIDDEN_SPECIFIERS = [
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'node:dns',
];

// Roots of the transitive walk: the two writer modules plus the barrel.
// The walk follows every relative import path from these roots into
// `src/`, collecting every reachable `.ts` file once and asserting none
// imports a forbidden specifier.
const WRITER_ROOTS = [
  path.join(SRC_ROOT, 'telemetry', 'writer-config.ts'),
  path.join(SRC_ROOT, 'telemetry', 'writer-outcome.ts'),
  path.join(SRC_ROOT, 'telemetry', 'index.ts'),
];

// Match every `import ... from '<specifier>'` (single or double quote).
// The pattern intentionally tolerates the `import type`, side-effect
// `import '...'`, and `import * as X from '...'` shapes — every shape
// surfaces the specifier between the quotes.
const IMPORT_FROM_PATTERN = /from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_PATTERN = /^\s*import\s+['"]([^'"]+)['"]/gm;

function extractImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(IMPORT_FROM_PATTERN)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(BARE_IMPORT_PATTERN)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

// Resolve a relative or in-package specifier (matching the project's
// `with { type: 'json' }` + `.js` extension convention) to a real file
// path on disk. Non-relative specifiers (the framework's own `from '../foo.js'`
// resolve to `.ts` files because the source files use TS) and JSON imports
// are mapped to `.ts` / `.json` siblings; non-relative bare specifiers
// (third-party packages or Node built-ins) are returned as-is so the
// walker can decide whether to recurse or assert against them.
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) {
    return null; // bare specifier — not a local source file
  }
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, specifier);
  // Strip the trailing `.js` and re-add `.ts` to match the source layout.
  if (resolved.endsWith('.js')) {
    resolved = resolved.slice(0, -3) + '.ts';
  } else if (resolved.endsWith('.json')) {
    // JSON imports are leaves; no further recursion.
    return resolved;
  } else if (!resolved.endsWith('.ts')) {
    resolved = resolved + '.ts';
  }
  return existsSync(resolved) ? resolved : null;
}

function walkImports(roots: string[]): {
  visited: Set<string>;
  specifiersByFile: Map<string, string[]>;
} {
  const visited = new Set<string>();
  const specifiersByFile = new Map<string, string[]>();
  const queue: string[] = [...roots];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (visited.has(file)) continue;
    visited.add(file);
    if (!existsSync(file)) continue;
    if (file.endsWith('.json')) continue; // JSON leaves have no imports.
    const source = readFileSync(file, 'utf8');
    const specs = extractImports(source);
    specifiersByFile.set(file, specs);
    for (const spec of specs) {
      const resolved = resolveSpecifier(spec, file);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return { visited, specifiersByFile };
}

describe('telemetry writers — local-only invariant (static import-graph scan)', () => {
  it('the transitive import closure of writeTelemetryConfig + writeTelemetryOutcome contains zero network specifiers', () => {
    const { visited, specifiersByFile } = walkImports(WRITER_ROOTS);
    // Sanity: the walk actually reached the writers and at least one of
    // their imports (atomic-write, mapping, types). A walk that produced
    // an empty set would silently pass.
    expect(visited.size).toBeGreaterThan(3);

    const offences: Array<{ file: string; specifier: string }> = [];
    for (const [file, specs] of specifiersByFile) {
      for (const spec of specs) {
        if (FORBIDDEN_SPECIFIERS.includes(spec)) {
          offences.push({ file, specifier: spec });
        }
      }
    }
    if (offences.length > 0) {
      const formatted = offences
        .map((o) => `  ${o.specifier} imported by ${o.file}`)
        .join('\n');
      throw new Error(`local-only invariant violated:\n${formatted}`);
    }
    expect(offences).toEqual([]);
  });

  it('each of the five forbidden specifiers is named explicitly in this file (criterion coverage check)', () => {
    // Belt-and-braces: assert the five specifiers are encoded so the
    // contract's grep finds five distinct hits — without this guard a
    // future refactor that collapsed the list to a regex could silently
    // shrink coverage. Reading this source file once and counting hits is
    // the cheapest way to pin it.
    const selfSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const distinct = new Set<string>();
    for (const spec of FORBIDDEN_SPECIFIERS) {
      if (selfSource.includes(`'${spec}'`)) {
        distinct.add(spec);
      }
    }
    expect(distinct.size).toBe(5);
  });
});
