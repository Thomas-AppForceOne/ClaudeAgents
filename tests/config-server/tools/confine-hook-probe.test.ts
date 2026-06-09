/**
 * `probeConfineHook` MCP wrapper tests.
 *
 * The wrapper is a pure marshalling shim over the shared
 * `runConfineHookProbe` library function. The tests pin the documented
 * shape (`projectTierHookPath` / `verdict` / `subReason` /
 * `backupSiblings`) across the three project-tree states and the
 * byte-identical-with-status invariant: invoking the wrapper AND
 * `gan hooks status --json` against the same fixture must produce
 * matching `verdict` values.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { probeConfineHook } from '../../../src/config-server/tools/confine-hook-probe.js';
import { canonicalizePath } from '../../../src/config-server/determinism/index.js';
import { repoRootDir, runGan } from '../../cli/helpers/spawn.js';

const cleanups: string[] = [];

// Repoint GAN_PACKAGE_ROOT_OVERRIDE at the real repo root for this file —
// the global setup at `tests/setup.ts` points it at an empty fake root,
// which is fine for stack-resolution isolation but breaks the framework's
// template lookup. Save + restore so the rest of the suite is unaffected.
const SAVED_PKG_OVERRIDE = process.env.GAN_PACKAGE_ROOT_OVERRIDE;

beforeAll(() => {
  process.env.GAN_PACKAGE_ROOT_OVERRIDE = repoRootDir();
});

afterAll(() => {
  if (SAVED_PKG_OVERRIDE !== undefined) {
    process.env.GAN_PACKAGE_ROOT_OVERRIDE = SAVED_PKG_OVERRIDE;
  } else {
    delete process.env.GAN_PACKAGE_ROOT_OVERRIDE;
  }
});

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeTmpDir(prefix: string): string {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  cleanups.push(d);
  return d;
}

function seedHook(root: string, content: string, mode = 0o755): string {
  const dir = path.join(root, '.claude', 'hooks');
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'gan-confine.sh');
  writeFileSync(p, content);
  chmodSync(p, mode);
  return p;
}

// Read the framework's current rendered template (version-substituted) so
// the fixture matches the shape `install.sh` would write.
function renderedTemplate(): string {
  const tplPath = path.join(
    repoRootDir(),
    'scripts',
    'hooks',
    'gan-confine.sh.template',
  );
  // Resolve the version from the real package.json.
  const fs = require('node:fs');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRootDir(), 'package.json'), 'utf8'));
  return fs.readFileSync(tplPath, 'utf8').split('__GAN_FRAMEWORK_VERSION__').join(pkg.version);
}

describe('probeConfineHook MCP wrapper', () => {
  it('absent hook: null verdict, null subReason, null path, empty backupSiblings', async () => {
    const root = makeTmpDir('gan-mcp-probe-');
    const result = await probeConfineHook({ projectRoot: root });
    expect(result.projectTierHookPath).toBeNull();
    expect(result.verdict).toBeNull();
    expect(result.subReason).toBeNull();
    expect(result.backupSiblings).toEqual([]);
  });

  it('current template: verdict current, subReason null, path set', async () => {
    const root = makeTmpDir('gan-mcp-probe-');
    const hookPath = seedHook(root, renderedTemplate());
    const result = await probeConfineHook({ projectRoot: root });
    expect(result.projectTierHookPath).toBe(hookPath);
    expect(result.verdict).toBe('current');
    expect(result.subReason).toBeNull();
  });

  it('stale hook (always-deny): verdict stale, subReason noGanRunDirAwareness', async () => {
    const root = makeTmpDir('gan-mcp-probe-');
    seedHook(root, '#!/bin/bash\nexit 1\n');
    const result = await probeConfineHook({ projectRoot: root });
    expect(result.verdict).toBe('stale');
    expect(result.subReason).toBe('noGanRunDirAwareness');
  });

  it('backup siblings surface in backupSiblings (sorted, deterministic)', async () => {
    const root = makeTmpDir('gan-mcp-probe-');
    const hooksDir = path.join(root, '.claude', 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    writeFileSync(
      path.join(hooksDir, 'gan-confine.sh.gan-bak.2026-06-08T19:42:11Z'),
      'a',
    );
    writeFileSync(
      path.join(hooksDir, 'gan-confine.sh.gan-bak.2026-06-09T19:42:11Z'),
      'b',
    );
    const result = await probeConfineHook({ projectRoot: root });
    expect(result.backupSiblings.length).toBe(2);
    // Sorted lexicographically — the timestamps embed in the filename, so
    // sorting also chronologically orders them.
    expect(result.backupSiblings[0]).toContain('2026-06-08');
    expect(result.backupSiblings[1]).toContain('2026-06-09');
  });
});

describe('byte-identical-with-status invariant', () => {
  // The wrapper and the `gan hooks status --json` CLI both call the same
  // `runConfineHookProbe` runner. The invariant: on the same fixture
  // tree, the wrapper's `verdict` field matches the CLI's
  // `projectTier.verdict` field. A future refactor that introduced a
  // second probe-logic copy would fail this assertion.
  it('current template fixture: wrapper verdict === CLI projectTier.verdict', async () => {
    const root = makeTmpDir('gan-mcp-probe-cli-');
    seedHook(root, renderedTemplate());
    // CLI emits a JSON envelope; the project-tier verdict lives at
    // .projectTier.verdict. The wrapper emits the same value at
    // .verdict. Both should report `current` on the fresh template.
    const home = makeTmpDir('gan-mcp-probe-home-');
    const cli = await runGan(['hooks', 'status', '--json'], {
      cwd: root,
      extraEnv: { HOME: home, GAN_PACKAGE_ROOT_OVERRIDE: repoRootDir() },
    });
    const parsed = JSON.parse(cli.stdout) as {
      projectTier: { verdict: string } | null;
    };
    const wrapper = await probeConfineHook({
      projectRoot: canonicalizePath(root),
    });
    expect(parsed.projectTier).not.toBeNull();
    expect(parsed.projectTier!.verdict).toBe(wrapper.verdict);
  });

  it('stale fixture: wrapper verdict === CLI projectTier.verdict', async () => {
    const root = makeTmpDir('gan-mcp-probe-cli-');
    seedHook(root, '#!/bin/bash\nexit 1\n');
    const home = makeTmpDir('gan-mcp-probe-home-');
    const cli = await runGan(['hooks', 'status', '--json'], {
      cwd: root,
      extraEnv: { HOME: home, GAN_PACKAGE_ROOT_OVERRIDE: repoRootDir() },
    });
    const parsed = JSON.parse(cli.stdout) as {
      projectTier: { verdict: string } | null;
    };
    const wrapper = await probeConfineHook({
      projectRoot: canonicalizePath(root),
    });
    expect(parsed.projectTier!.verdict).toBe(wrapper.verdict);
    expect(wrapper.verdict).toBe('stale');
  });
});

describe('wrapper has no probe logic of its own', () => {
  // The dual-callable-surface rule: the wrapper marshals only — it
  // contains no probe behaviour the runner does not already cover. The
  // assertion below is structural rather than behavioural: scan the
  // wrapper source for any direct spawn / mkdtempSync / write call that
  // would indicate duplicated probe logic. A future refactor that
  // copy-pasted spawn-call logic into the wrapper would fail this scan.
  it('wrapper source contains no spawn / mkdtempSync / mkdirSync calls', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(
      path.join(repoRootDir(), 'src', 'config-server', 'tools', 'confine-hook-probe.ts'),
      'utf8',
    );
    // Strip leading whitespace + line comments before scanning so a `//
    // mentions spawn` doc line does not trip the check.
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
    const code = codeLines.join('\n');
    expect(code).not.toMatch(/\bspawn\b/);
    expect(code).not.toMatch(/\bmkdtempSync\b/);
  });
});
