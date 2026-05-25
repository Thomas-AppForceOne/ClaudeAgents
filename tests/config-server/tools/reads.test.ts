/**
 * One positive smoke test per read tool (the S2 read surface). This is the
 * "every reader works and returns its documented shape" baseline — deliberately
 * shallow per tool, broad across the whole catalogue, so that a reader silently
 * breaking or changing its result shape is caught even if no deeper suite
 * exercises it.
 *
 * Run mostly against the clean `js-ts-minimal` fixture, so the expected answers
 * are the empty/default forms (no active stacks, empty overlay merge, no module
 * state). A few tools need richer setup, kept local to their test:
 *   - getTrustState runs against a throwaway temp home so it reports the
 *     unapproved-but-hash-present state without reading the real trust cache;
 *   - getTrustDiff is still a deferred stub — the test pins its stub shape AND
 *     asserts it logs exactly one warning tagged with the tool name (the spy
 *     logger captures structured log entries for that assertion);
 *   - getModuleState is checked for both an unknown module and an undeclared
 *     key, both of which must return null (consistent no-file semantics, never
 *     a throw).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getActiveStacks,
  getBoundedDirectoryListing,
  getMergedSplicePoints,
  getModuleState,
  getOverlay,
  getResolvedConfig,
  getStack,
  getStackResolution,
  getTrustDiff,
  getTrustState,
  listModules,
} from '../../../src/config-server/tools/reads.js';
import { getApiVersion } from '../../../src/config-server/index.js';
import type { Logger } from '../../../src/config-server/logging/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

interface RecordedEntry {
  level: 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}

// Capturing logger: records every structured log call so a test can assert on
// level, message, and metadata. Used by the getTrustDiff test to prove the
// stub emits exactly one warning tagged with its tool name.
function makeSpyLogger(): { logger: Logger; entries: RecordedEntry[] } {
  const entries: RecordedEntry[] = [];
  const logger: Logger = {
    info: (msg, meta) => entries.push({ level: 'info', msg, meta }),
    warn: (msg, meta) => entries.push({ level: 'warn', msg, meta }),
    error: (msg, meta) => entries.push({ level: 'error', msg, meta }),
    sink: () => 'spy',
  };
  return { logger, entries };
}

describe('S2 read tools (one positive test per tool)', () => {
  it('getApiVersion returns a semver-shaped string', async () => {
    const result = await getApiVersion();
    expect(result.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('getResolvedConfig returns the full F2 shape', async () => {

    const { clearResolvedConfigCache } =
      await import('../../../src/config-server/resolution/cache.js');
    clearResolvedConfigCache();
    const result = await getResolvedConfig({ projectRoot: jsTsMinimal });
    expect(result.apiVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.schemaVersions).toEqual({ stack: 1, overlay: 1 });

    expect(result.stacks.active).toEqual([]);
    expect(result.stacks.byName).toEqual({});

    expect(result.overlay).toEqual({});
    expect(result.discarded).toEqual([]);
    expect(result.additionalContext.planner).toEqual([]);
    expect(result.additionalContext.proposer).toEqual([]);
    expect(result.issues).toEqual([]);
  });

  it('getStack loads a stack with tier provenance', () => {
    const result = getStack({ projectRoot: jsTsMinimal, name: 'web-node' });
    expect(result.sourceTier).toBe('builtin');
    const data = result.data as Record<string, unknown>;
    expect(data.name).toBe('web-node');
  });

  it('getActiveStacks returns the detected active set (empty for js-ts-minimal)', async () => {
    const { clearResolvedConfigCache } =
      await import('../../../src/config-server/resolution/cache.js');
    clearResolvedConfigCache();

    const result = getActiveStacks({ projectRoot: jsTsMinimal });
    expect(result.active).toEqual([]);
  });

  it('getOverlay returns the project-tier overlay or null', () => {
    const project = getOverlay({ projectRoot: jsTsMinimal, tier: 'project' });
    expect(project).not.toBeNull();
    expect(project!.tier).toBe('project');
    const def = getOverlay({ projectRoot: jsTsMinimal, tier: 'default' });
    expect(def).toBeNull();
  });

  it('getMergedSplicePoints returns the cascaded overlay (S5 full)', async () => {
    const { clearResolvedConfigCache } =
      await import('../../../src/config-server/resolution/cache.js');
    clearResolvedConfigCache();
    const result = getMergedSplicePoints({ projectRoot: jsTsMinimal });

    expect(result.mergedSplicePoints).toEqual({});
  });

  it('getTrustState (R5 S4) reports approved: false with a current hash and a summary', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const tmpHome = mkdtempSync(path.join(tmpdir(), 'cas-trust-state-home-'));
    try {
      const result = getTrustState({ projectRoot: jsTsMinimal }, { homeDir: tmpHome });
      expect(result.approved).toBe(false);
      expect(typeof result.currentHash).toBe('string');
      expect(result.currentHash.startsWith('sha256:')).toBe(true);
      expect(result.summary).toBeDefined();
      expect(typeof result.summary?.additionalChecksCount).toBe('number');
      expect(result.summary?.perStackOverridesCount).toBe(0);
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('getTrustDiff returns the deferred stub shape and logs a warning', () => {
    const { logger, entries } = makeSpyLogger();
    const result = getTrustDiff({ projectRoot: jsTsMinimal }, { logger });
    expect(result).toEqual({ diff: [], reason: 'trust-diff-deferred' });
    const warns = entries.filter((e) => e.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].meta).toEqual({ tool: 'getTrustDiff' });
  });

  it('getModuleState returns null when no state file exists for the key', () => {
    const result = getModuleState({
      projectRoot: jsTsMinimal,
      name: 'anything',
      key: 'port-registry',
    });
    expect(result).toBeNull();
  });

  it('getModuleState returns null for an undeclared key (consistent with no-file)', () => {
    const result = getModuleState({
      projectRoot: jsTsMinimal,
      name: 'anything',
      key: 'never-declared',
    });
    expect(result).toBeNull();
  });

  it('listModules returns an empty list (M1 no-op)', () => {
    const result = listModules({ projectRoot: jsTsMinimal });
    expect(result.modules).toEqual([]);
  });

  it('getStackResolution returns the path + tier for the resolved stack', () => {
    const result = getStackResolution({ projectRoot: jsTsMinimal, name: 'web-node' });
    expect(result.tier).toBe('builtin');
    expect(result.path.endsWith(path.join('stacks', 'web-node.md'))).toBe(true);
  });
});

describe('getBoundedDirectoryListing (read tool)', () => {
  // This tool needs an *active* stack with a declared scope (js-ts-minimal has
  // none). The fixture activates the builtin web-node by satisfying its real
  // detection (a manifest plus a lockfile), so its declared TS scope is what the
  // tool unions; a .gitignore'd dependency-like tree must be pruned. A temp user
  // home keeps resolution hermetic.
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  function makeProject(): { projectRoot: string; userHome: string } {
    const projectRoot = mkdtempSync(path.join(tmpdir(), 'bdl-tool-proj-'));
    const userHome = mkdtempSync(path.join(tmpdir(), 'bdl-tool-home-'));
    tmpDirs.push(projectRoot, userHome);

    mkdirSync(path.join(projectRoot, '.claude', 'gan'), { recursive: true });
    writeFileSync(
      path.join(projectRoot, '.claude', 'gan', 'project.md'),
      ['---', 'schemaVersion: 1', '---', ''].join('\n'),
    );
    // A manifest plus a lockfile satisfy the builtin web-node's detection, so it
    // becomes the active stack and contributes its declared **/*.ts scope.
    writeFileSync(
      path.join(projectRoot, 'package.json'),
      '{"name":"bdl-fixture","scripts":{"build":"echo build"}}\n',
    );
    writeFileSync(path.join(projectRoot, 'package-lock.json'), '{}\n');

    mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
    mkdirSync(path.join(projectRoot, 'vendor_pkgs', 'dep'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'src', 'index.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(projectRoot, 'vendor_pkgs', 'dep', 'lib.ts'), 'export const v = 1;\n');
    // The project declares the dependency-like tree uninteresting; the listing
    // must honour that without this test (or the tool) naming the directory.
    writeFileSync(path.join(projectRoot, '.gitignore'), 'vendor_pkgs\n');
    return { projectRoot, userHome };
  }

  it('returns a scope-filtered, gitignore-pruned listing resolved from the active stacks', async () => {
    const { clearResolvedConfigCache } =
      await import('../../../src/config-server/resolution/cache.js');
    clearResolvedConfigCache();
    const { projectRoot, userHome } = makeProject();

    // The suite's global setup points the package root at an empty fake root (no
    // builtin stacks), so steer resolution at the real repo whose builtin
    // web-node declares the **/*.ts scope this assertion depends on.
    const listing = getBoundedDirectoryListing(
      { projectRoot },
      { userHome, packageRoot: repoRoot },
    );

    // In scope (the active web-node stack's **/*.ts) and not ignored.
    expect(listing.scopedFiles).toContain('src/index.ts');
    // Ignored by the project's own .gitignore — pruned from the walk.
    expect(listing.scopedFiles).not.toContain('vendor_pkgs/dep/lib.ts');
    // Out of scope (.md) never appears regardless of location.
    expect(listing.scopedFiles.some((p) => p.endsWith('.md'))).toBe(false);
    // Top-level shape excludes the ignored tree.
    expect(listing.topLevelDirectories).toContain('src');
    expect(listing.topLevelDirectories).not.toContain('vendor_pkgs');
  });
});
