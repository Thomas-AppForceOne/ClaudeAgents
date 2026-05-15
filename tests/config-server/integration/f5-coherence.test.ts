/**
 * F5 integration tests — server-side cache coherence + schema-runtime
 * alignment for the MCP tool surface.
 *
 * Spec: `specifications/F5-config-api-coherence.md`.
 *
 * Covers the four acceptance-criteria categories:
 *
 *  1. After every state-mutating tool, the resolver cache is
 *     invalidated synchronously (the next read sees the post-mutation
 *     state). Tested two ways: (a) populating the cache, calling the
 *     mutator, and asserting the entry has been dropped; (b) spying on
 *     the cache singleton's `invalidate` method and observing the
 *     write path call it with the project's canonical root.
 *  2. After a hand-edit to a backing file (simulated by `utimesSync`
 *     advancing the mtime, plus a meaningful content change so the
 *     recomputed snapshot is observably different), the next read
 *     path recomputes from disk even without an explicit invalidation
 *     call.
 *  3. The MCP `tools/list` response excludes the two `NotImplemented`
 *     stubs (`getOverlayField`, `getStackConventions`). The assertion
 *     is behavioural — it does not couple to the filter's
 *     implementation, so the test still holds if the filter logic
 *     changes as long as the surface contract is preserved.
 *  4. The in-tree schema at `schemas/api-tools-v1.json` and the
 *     runtime parameter validators agree on every wired tool's
 *     required-field list. Both sides are read from `buildToolList()`,
 *     which surfaces `required` (runtime contract, co-located with the
 *     dispatch handler) and `inputSchema.required` (documented
 *     contract); no hand-curated parallel map.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  buildToolList,
  F2_TOOL_NAMES,
} from '../../../src/config-server/index.js';
import {
  ResolvedConfigCache,
  backingFileMtime,
  cacheKeyForProjectRoot,
  clearResolvedConfigCache,
  getResolvedConfigCache,
} from '../../../src/config-server/resolution/cache.js';
import { composeResolvedConfig } from '../../../src/config-server/resolution/resolved-config.js';
import {
  appendToModuleState,
  registerModule,
  removeFromModuleState,
  setModuleState,
  setOverlayField,
  trustApprove,
  trustRevoke,
} from '../../../src/config-server/tools/writes.js';

const tmpRoots: string[] = [];

function makeFixture(): { projectRoot: string; userHome: string } {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'f5-coherence-proj-'));
  const userHome = mkdtempSync(path.join(tmpdir(), 'f5-coherence-home-'));
  tmpRoots.push(projectRoot, userHome);
  mkdirSync(path.join(projectRoot, '.claude', 'gan'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, '.claude', 'gan', 'project.md'),
    ['---', 'schemaVersion: 1', '---', ''].join('\n'),
  );
  mkdirSync(path.join(projectRoot, 'stacks'), { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'stacks', 'web-node.md'),
    [
      '---',
      'name: web-node',
      'schemaVersion: 1',
      'detection:',
      '  - package.json',
      '---',
      '',
    ].join('\n'),
  );
  writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"f5-fixture"}\n');
  return { projectRoot, userHome };
}

beforeEach(() => clearResolvedConfigCache());

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of tmpRoots.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  clearResolvedConfigCache();
});

// ----------------------------------------------------------------------------
// Slice 1 — `tools/list` filter
// ----------------------------------------------------------------------------

describe('F5 slice 1 — tools/list excludes NotImplemented stubs', () => {
  it('buildToolList omits getOverlayField and getStackConventions', () => {
    const names = buildToolList().map((t) => t.name);
    expect(names).not.toContain('getOverlayField');
    expect(names).not.toContain('getStackConventions');
  });

  it('every advertised tool is a known F2 tool name', () => {
    for (const tool of buildToolList()) {
      expect(F2_TOOL_NAMES, `tool '${tool.name}' is not in F2_TOOL_NAMES`).toContain(tool.name);
    }
  });

  it('every advertised tool carries both runtime required and schema inputSchema', () => {
    for (const tool of buildToolList()) {
      expect(tool.required).toBeDefined();
      expect(Array.isArray(tool.required)).toBe(true);
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema['type']).toBe('object');
    }
  });
});

// ----------------------------------------------------------------------------
// Slice 2 — cache invalidation on state-mutating writes
// ----------------------------------------------------------------------------

describe('F5 slice 2 — every state-mutating write invalidates the resolver cache', () => {
  it('setOverlayField invalidates the cache entry for the project', async () => {
    const { projectRoot, userHome } = makeFixture();
    await composeResolvedConfig(projectRoot, { userHome });
    expect(getResolvedConfigCache().size()).toBe(1);

    const result = setOverlayField(
      {
        projectRoot,
        tier: 'project',
        fieldPath: 'planner.additionalContext',
        value: ['docs/intro.md'],
      },
      { userHome },
    );
    expect(result.mutated).toBe(true);
    expect(getResolvedConfigCache().size()).toBe(0);
  });

  it('setOverlayField calls cache.invalidate with the canonical project root', async () => {
    // Stronger than the size assertion above: spy on the cache's
    // `invalidate` method and confirm the write path passes the
    // canonical root. Covers the F5 "synchronously, before return"
    // discipline structurally — if the invalidate call moved out of
    // band or was dropped, this test fails.
    const { projectRoot, userHome } = makeFixture();
    const cache = getResolvedConfigCache();
    const spy = vi.spyOn(cache, 'invalidate');

    setOverlayField(
      {
        projectRoot,
        tier: 'project',
        fieldPath: 'planner.additionalContext',
        value: ['docs/intro.md'],
      },
      { userHome },
    );

    expect(spy).toHaveBeenCalledWith(cacheKeyForProjectRoot(projectRoot));
  });

  it('trustApprove invalidates the cache entry for the project', async () => {
    const { projectRoot, userHome } = makeFixture();
    await composeResolvedConfig(projectRoot, { userHome });
    expect(getResolvedConfigCache().size()).toBe(1);

    const result = trustApprove({ projectRoot }, { homeDir: userHome });
    expect(result.mutated).toBe(true);
    expect(getResolvedConfigCache().size()).toBe(0);
  });

  it('trustApprove calls cache.invalidate with the canonical project root', () => {
    const { projectRoot, userHome } = makeFixture();
    const cache = getResolvedConfigCache();
    const spy = vi.spyOn(cache, 'invalidate');

    trustApprove({ projectRoot }, { homeDir: userHome });

    expect(spy).toHaveBeenCalledWith(cacheKeyForProjectRoot(projectRoot));
  });

  it('trustRevoke invalidates the cache when an approval was removed', async () => {
    const { projectRoot, userHome } = makeFixture();
    trustApprove({ projectRoot }, { homeDir: userHome });
    clearResolvedConfigCache();
    await composeResolvedConfig(projectRoot, { userHome });
    expect(getResolvedConfigCache().size()).toBe(1);

    const result = trustRevoke({ projectRoot }, { homeDir: userHome });
    expect(result.mutated).toBe(true);
    expect(getResolvedConfigCache().size()).toBe(0);
  });

  it('trustRevoke does NOT invalidate on no-op (mutated:false)', async () => {
    const { projectRoot, userHome } = makeFixture();
    await composeResolvedConfig(projectRoot, { userHome });
    const cache = getResolvedConfigCache();
    const spy = vi.spyOn(cache, 'invalidate');

    const result = trustRevoke({ projectRoot }, { homeDir: userHome });
    expect(result.mutated).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(cache.size()).toBe(1);
  });

  it('module writes fail-fast on unknown module without invalidating (mutated:false)', async () => {
    // Without a real module manifest, every module write throws on the
    // manifest pre-check. Invalidation MUST NOT fire on the failure
    // path: a failed pre-condition is not a state mutation. (The
    // success-path invalidation is structurally co-located with the
    // disk write in writes.ts; M1 fixture infrastructure for an end-
    // to-end success test is out of F5's scope.)
    const { projectRoot, userHome } = makeFixture();
    await composeResolvedConfig(projectRoot, { userHome });
    const cache = getResolvedConfigCache();
    const spy = vi.spyOn(cache, 'invalidate');

    expect(() =>
      setModuleState({
        projectRoot,
        name: 'no-such-module',
        key: 'no-such-key',
        state: { whatever: 1 },
      }),
    ).toThrow();
    expect(() =>
      appendToModuleState({
        projectRoot,
        name: 'no-such-module',
        key: 'no-such-key',
        fieldPath: 'list',
        value: { key: 'a' },
      }),
    ).toThrow();
    expect(() =>
      removeFromModuleState({
        projectRoot,
        name: 'no-such-module',
        key: 'no-such-key',
        entryKey: 'nope',
      }),
    ).toThrow();

    expect(spy).not.toHaveBeenCalled();
    expect(cache.size()).toBe(1);
  });

  it('registerModule probe with unknown module does NOT invalidate', async () => {
    const { projectRoot, userHome } = makeFixture();
    await composeResolvedConfig(projectRoot, { userHome });
    const cache = getResolvedConfigCache();
    const spy = vi.spyOn(cache, 'invalidate');

    const result = registerModule({
      projectRoot,
      name: 'definitely-not-a-real-module',
      manifest: {},
    });
    expect(result.mutated).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(cache.size()).toBe(1);
  });
});

// ----------------------------------------------------------------------------
// Slice 3 — mtime-driven invalidation on reads
// ----------------------------------------------------------------------------

describe('F5 slice 3 — mtime-driven invalidation on reads', () => {
  it('cache.get returns undefined when a backing file mtime advances', () => {
    const cache = new ResolvedConfigCache<{ v: number }>();
    const tmp = mkdtempSync(path.join(tmpdir(), 'f5-mtime-'));
    tmpRoots.push(tmp);
    const filePath = path.join(tmp, 'overlay.md');
    writeFileSync(filePath, 'initial content');

    const initial = backingFileMtime(filePath);
    expect(initial).not.toBeNull();
    const states = new Map<string, number | null>([[filePath, initial]]);
    cache.set('/proj', { v: 1 }, states);
    expect(cache.get('/proj')).toEqual({ v: 1 });

    const futureSec = Date.now() / 1000 + 60;
    utimesSync(filePath, futureSec, futureSec);

    expect(cache.get('/proj')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('cache.get returns undefined when a tracked-absent file appears', () => {
    const cache = new ResolvedConfigCache<{ v: number }>();
    const tmp = mkdtempSync(path.join(tmpdir(), 'f5-mtime-appear-'));
    tmpRoots.push(tmp);
    const missingPath = path.join(tmp, 'not-yet-written.md');

    const states = new Map<string, number | null>([[missingPath, null]]);
    cache.set('/proj', { v: 1 }, states);
    expect(cache.get('/proj')).toEqual({ v: 1 });

    writeFileSync(missingPath, 'new content');
    expect(cache.get('/proj')).toBeUndefined();
  });

  it('cache.get returns undefined when a tracked-present file disappears', () => {
    const cache = new ResolvedConfigCache<{ v: number }>();
    const tmp = mkdtempSync(path.join(tmpdir(), 'f5-mtime-disappear-'));
    tmpRoots.push(tmp);
    const filePath = path.join(tmp, 'overlay.md');
    writeFileSync(filePath, 'initial');
    const initial = backingFileMtime(filePath);
    const states = new Map<string, number | null>([[filePath, initial]]);
    cache.set('/proj', { v: 1 }, states);
    expect(cache.get('/proj')).toEqual({ v: 1 });

    rmSync(filePath);
    expect(cache.get('/proj')).toBeUndefined();
  });

  it('cache.get with empty backing states never invalidates on mtime', () => {
    const cache = new ResolvedConfigCache<{ v: number }>();
    cache.set('/proj', { v: 1 });
    expect(cache.get('/proj')).toEqual({ v: 1 });
  });

  it('composeResolvedConfig reflects a hand-edit to project.md on the next read', async () => {
    const { projectRoot, userHome } = makeFixture();
    const overlayPath = path.join(projectRoot, '.claude', 'gan', 'project.md');

    // First compose: empty overlay, no planner.additionalContext.
    const before = await composeResolvedConfig(projectRoot, { userHome });
    const beforePlanner = before.overlay['planner'] as
      | { additionalContext?: unknown }
      | undefined;
    expect(beforePlanner?.additionalContext).toBeUndefined();

    // Simulate a hand-edit: add a planner.additionalContext entry.
    writeFileSync(
      overlayPath,
      [
        '---',
        'schemaVersion: 1',
        'planner:',
        '  additionalContext:',
        '    - docs/intro.md',
        '---',
        '',
      ].join('\n'),
    );
    // Advance mtime to guarantee detection on filesystems with low
    // mtime precision (HFS+ rounds to 1s; this puts the new mtime
    // well past any rounding boundary).
    const futureSec = Date.now() / 1000 + 60;
    utimesSync(overlayPath, futureSec, futureSec);

    // Second compose: the cache must detect the mtime change, drop
    // the stale entry, recompute, and surface the edit.
    const after = await composeResolvedConfig(projectRoot, { userHome });
    const afterPlanner = after.overlay['planner'] as
      | { additionalContext?: unknown }
      | undefined;
    expect(afterPlanner?.additionalContext).toEqual(['docs/intro.md']);
  });

  it('composeResolvedConfig picks up a brand-new higher-tier stack shadow', async () => {
    // Closes the gap where adding a project-shadow stack file at
    // `<root>/.claude/gan/stacks/<name>.md` did not bust the cache:
    // the previous-active builtin path was tracked, but the
    // not-yet-existing project shadow was not. F5 now records absent
    // shadow paths so a fresh appearance flips the state.
    const { projectRoot, userHome } = makeFixture();
    const stacksDir = path.join(projectRoot, '.claude', 'gan', 'stacks');
    const shadowPath = path.join(stacksDir, 'web-node.md');

    // First compose: no project shadow exists; builtin tier is active.
    const before = await composeResolvedConfig(projectRoot, { userHome });
    const webNodeBefore = before.stacks.byName['web-node'];
    expect(webNodeBefore?.tier).toBe('builtin');

    // Add a project shadow. Note: the resolver picks the highest
    // tier, so adding this file MUST change which tier is active.
    mkdirSync(stacksDir, { recursive: true });
    writeFileSync(
      shadowPath,
      [
        '---',
        'name: web-node',
        'schemaVersion: 1',
        'detection:',
        '  - package.json',
        '---',
        '',
      ].join('\n'),
    );

    // The cache must invalidate so the recomputed snapshot reflects
    // the new project-shadow tier. Compare via `endsWith` because the
    // resolver canonicalises paths (e.g. macOS' `/tmp` →
    // `/private/var/folders/.../t/...` with lowercased segments) and
    // the test fixture path is the un-canonicalised mkdtemp result.
    const after = await composeResolvedConfig(projectRoot, { userHome });
    const webNodeAfter = after.stacks.byName['web-node'];
    expect(webNodeAfter?.tier).toBe('project');
    expect(webNodeAfter?.path.endsWith('/.claude/gan/stacks/web-node.md')).toBe(true);
  });
});

// ----------------------------------------------------------------------------
// Slice 4 — schema-runtime alignment
// ----------------------------------------------------------------------------

describe('F5 slice 4 — schemas/api-tools-v1.json agrees with runtime validators', () => {
  // Both sides are read from `buildToolList()`. Each entry carries the
  // runtime's `required` declaration (co-located with the dispatch
  // handler in `TOOL_HANDLERS`) AND the schema's `inputSchema.required`
  // (read from `schemas/api-tools-v1.json`). No hand-curated parallel
  // map; drift in either direction fails the parity test.
  for (const tool of buildToolList()) {
    it(`${tool.name}: schema.required matches runtime required-fields`, () => {
      const schemaRequired = ((tool.inputSchema['required'] as string[]) ?? [])
        .slice()
        .sort();
      const runtimeRequired = [...tool.required].sort();
      expect(schemaRequired).toEqual(runtimeRequired);
    });

    it(`${tool.name}: schema.properties advertises every runtime required field`, () => {
      const props = Object.keys(
        (tool.inputSchema['properties'] as Record<string, unknown>) ?? {},
      );
      for (const f of tool.required) {
        expect(props, `tool '${tool.name}' missing property '${f}'`).toContain(f);
      }
    });
  }
});
