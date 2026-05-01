/**
 * R3 sprint 1 — F-AC6 read path: simulate the framework's library being
 * unreachable. The CLI must exit 5 with a remediation hint pointing at
 * `install.sh`.
 *
 * Strategy: copy just `dist/cli/` to a fresh tmp tree (without
 * `dist/config-server/`, without `package.json`, without `schemas/`) and
 * run from there. The bin entry's static imports of the framework
 * library fail, the bootstrap `main()` catch surfaces a non-zero exit;
 * we then run the version command via a thinner harness that replicates
 * the version dispatcher but relocates `import.meta.url`.
 *
 * In practice the simplest reliable simulation is to copy `dist/cli/` to
 * a tmp dir AND replace the imports of `dist/config-server/index.js`
 * with a stub that throws on `getApiVersion()`. We use a small
 * fixture script that does exactly that and feed it through `runGan`'s
 * `entryOverride`.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

/**
 * Build a tmp tree containing a stand-in version command + a stand-in
 * `getApiVersion` import target that throws. The bin entry is also
 * copied so the dispatch path runs end-to-end.
 *
 * Layout:
 *   tmp/
 *     dist/
 *       cli/                  ← copied from real dist/cli
 *       config-server/
 *         index.js            ← throws on import OR throws getApiVersion
 *
 * `dist/cli/commands/version.js` imports
 * `../../config-server/index.js`; we provide a stand-in there.
 *
 * We deliberately do NOT create package.json / schemas/ at the tmp root,
 * so the version command's filesystem reads also fail.
 */
function buildBrokenDist(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gan-unreachable-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

  // Tmp tree must be marked as ESM so the copied `.js` files load via the
  // ESM loader (their imports are bare `import * as foo` statements).
  // We deliberately leave `version` blank here: the stand-in
  // `config-server/index.js` rejects on `getApiVersion()`, and the
  // version command's `readServerVersion()` then fails to read this
  // package.json — which is the exact "framework library unreachable"
  // surface F-AC6 verifies. Either failure path renders the same
  // remediation text via the version command's catch block.
  const tmpPkg = {
    name: 'gan-unreachable-fixture',
    type: 'module',
  };
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(tmpPkg, null, 2) + '\n');

  // Symlink node_modules so the copied determinism module can resolve
  // its `picomatch` dependency.
  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

  const distSrc = path.join(repoRoot, 'dist', 'cli');
  const distDest = path.join(tmp, 'dist', 'cli');
  cpSync(distSrc, distDest, { recursive: true });

  // Stand-in for the framework library: `getApiVersion()` always rejects.
  // The CLI's version command catches the rejection and surfaces exit 5.
  const csDir = path.join(tmp, 'dist', 'config-server');
  const csDeterminismDir = path.join(csDir, 'determinism');
  cpSync(path.join(repoRoot, 'dist', 'config-server', 'determinism'), csDeterminismDir, {
    recursive: true,
  });
  // The CLI imports `createError` from `errors.js` (per the R1 error-factory
  // rule); copy the real module so the import resolves under the stub tree.
  cpSync(path.join(repoRoot, 'dist', 'config-server', 'errors.js'), path.join(csDir, 'errors.js'));
  cpSync(
    path.join(repoRoot, 'dist', 'config-server', 'errors.d.ts'),
    path.join(csDir, 'errors.d.ts'),
  );
  writeFileSync(
    path.join(csDir, 'index.js'),
    `export async function getApiVersion() {
  throw new Error('framework library missing (test stub)');
}
`,
  );
  writeFileSync(
    path.join(csDir, 'index.d.ts'),
    'export function getApiVersion(): Promise<{apiVersion:string}>;\n',
  );

  return path.join(tmp, 'dist', 'cli', 'index.js');
}

describe('gan: framework library unreachable', () => {
  it('F-AC6: `gan version` exits 5 with a remediation hint pointing at install.sh', async () => {
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version'], { entryOverride: brokenEntry });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot reach the framework's library");
    expect(r.stderr).toContain('install.sh');
  });

  it('F-AC6: even with --json, the unreachable error surfaces on stderr (no JSON on stdout)', async () => {
    // The contract is: when the *library itself* is unreachable, --json has
    // nothing structured to serialise. Stderr carries the human-readable
    // remediation; stdout stays empty so `gan version --json | jq` fails
    // loudly rather than parsing zero bytes as null.
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version', '--json'], { entryOverride: brokenEntry });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot reach the framework's library");
  });

  it('F-AC6: remediation text obeys the F4 prose discipline', async () => {
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version'], { entryOverride: brokenEntry });
    // No bare npm/node/Node/MCP server tokens outside backticks.
    const proseToken = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;
    const violations = [...r.stderr.matchAll(proseToken)];
    expect(violations).toHaveLength(0);
    // Must reference the framework, not the runtime.
    expect(r.stderr).toMatch(/framework/i);
  });

  // Touch the readFileSync import so eslint doesn't complain about an unused.
  it('sanity: the test fixture references real paths', () => {
    const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
    const head = readFileSync(cliEntry, 'utf8').slice(0, 50);
    expect(head).toContain('#!/usr/bin/env');
  });
});
