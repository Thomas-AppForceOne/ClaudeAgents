/**
 * Black-box integration test for `scripts/checks/no-second-mcp-server.mjs`,
 * the sentinel that backstops the "the package exposes exactly two bins
 * (claudeagents-config-server, gan)" invariant.
 *
 * Until the matching `.github/workflows/test-no-second-mcp-server.yml`
 * workflow merges, this test gives the existing `npm test` job a hook into
 * the same property — a future regression that adds a third bin (or drops
 * one) fails this test on the next CI run, regardless of whether the
 * dedicated workflow has landed yet.
 *
 * The test pattern mirrors the multi-process round-trip already used in
 * `tests/config-server/tools/docker-tools.test.ts:402-405`: a real
 * `spawnSync` of the script as a child process, exit-code + stdout/stderr
 * assertions on the result. The script is invoked against the live
 * `package.json` at the repo root (the same input CI will see) so the
 * assertion binds to the production input, not a hand-mirrored fake.
 *
 * Regression guarded: the script's version branch reappearing (which would
 * make the sentinel un-runnable on any minor bump and reintroduce I-001),
 * the bin-set assertion regressing to a length-only check, or the script
 * exiting non-zero on the canonical bin set.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

// Resolve the repo root from this file's own location (tests/scripts), two
// levels up — so the test works regardless of the caller's cwd.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'checks', 'no-second-mcp-server.mjs');

// Temp scan-roots created per test, swept in afterAll.
const tmpRoots: string[] = [];

function newTmpRoot(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'no-second-mcp-server-'));
  tmpRoots.push(tmp);
  return tmp;
}

afterAll(() => {
  for (const r of tmpRoots) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
});

describe('no-second-mcp-server sentinel', () => {
  it('live package.json at repo root → exit 0; stdout `no-second-mcp-server: ok`', () => {
    // The structural test in docker-tools.test.ts:445-464 already asserts
    // the bin set in-process; this case proves the same property survives
    // a cross-process spawn of the sentinel script against the real file
    // CI will read. Together they pin both ends of the invariant.
    const child = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
    });
    expect(child.status, `stderr: ${child.stderr}`).toBe(0);
    expect(child.stdout).toContain('no-second-mcp-server: ok');
    expect(child.stderr).toBe('');
  });

  it('package.json with a third bin entry → exit 1; stderr names the diverged set', () => {
    // The defect the sentinel guards against: a future PR landing a second
    // MCP server (or any third bin) goes through the live package.json. A
    // planted-drift fixture proves the bin-set assertion catches it; a
    // length-only check would silently pass when the count changed in a
    // way that still hit the expected total.
    const root = newTmpRoot();
    const livePkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      [k: string]: unknown;
    };
    const planted = {
      ...livePkg,
      bin: {
        ...livePkg.bin,
        'second-mcp-server': './dist/second-server/index.js',
      },
    };
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(planted, null, 2), 'utf8');

    const child = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('package.json bin set diverged');
    expect(child.stderr).toContain('second-mcp-server');
  });

  it('package.json missing a canonical bin → exit 1; stderr names the diverged set', () => {
    // The symmetric regression: a future PR dropping one of the two
    // canonical bins must also be flagged. A bin-set comparison is the
    // only check that catches both directions.
    const root = newTmpRoot();
    const livePkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      [k: string]: unknown;
    };
    const trimmed: Record<string, string> = {};
    for (const [k, v] of Object.entries(livePkg.bin)) {
      if (k !== 'gan') trimmed[k] = v;
    }
    const planted = { ...livePkg, bin: trimmed };
    writeFileSync(path.join(root, 'package.json'), JSON.stringify(planted, null, 2), 'utf8');

    const child = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('package.json bin set diverged');
  });

  it('the script no longer pins a hard-coded package version', () => {
    // I-001 regression guard: the original sentinel hard-coded
    // `expectedVersion = '0.1.0'`, which made it un-runnable against the
    // bumped `0.2.0` package and reintroduces the two-homes-for-one-fact
    // defect on every future minor bump. The fix is to delete the version
    // branch entirely; this assertion locks that deletion in.
    const source = readFileSync(scriptPath, 'utf8');
    expect(source).not.toMatch(/expectedVersion/);
    expect(source).not.toMatch(/pkg\.version/);
  });
});
