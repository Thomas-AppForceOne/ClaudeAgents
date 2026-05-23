/**
 * F5 "coherence" suite — the cross-cutting invariants that keep the advertised
 * tool surface, the cache, and the JSON tool schemas all telling the same
 * story. It is organised into four slices, each guarding a distinct seam:
 *
 *   slice 1 — tools/list only advertises real, implemented F2 tools (no
 *     NotImplemented stubs leak out) and each carries a well-formed schema;
 *   slice 2 — every state-mutating write invalidates the resolver cache for
 *     exactly the affected project, AND no-op / failed writes do NOT (a stale
 *     or wrongly-evicted cache entry is the regression this catches);
 *   slice 3 — mtime-driven invalidation: a cached resolved config is silently
 *     dropped when any tracked backing file changes, appears, or disappears,
 *     so a hand-edit to an overlay/stack shows up on the very next read;
 *   slice 4 — the static schemas/api-tools-v1.json `required` set agrees field
 *     for field with the runtime validators (drift here means a client could
 *     send input the server rejects, or vice versa).
 *
 * `makeFixture` builds a minimal but complete project (project overlay + a
 * web-node stack + package.json) in a fresh temp dir, paired with a temp user
 * home, so the trust/overlay tools have somewhere hermetic to write.
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
    // The previous test proved the cache *empties*; this one pins down the
    // exact key passed, so a future change cannot invalidate a different (or
    // un-canonicalised) project root and accidentally pass the size() check.
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
    // No prior approval here, so revoke is a genuine no-op. The invariant: a
    // write that changed nothing must leave the (still-valid) cache untouched,
    // not blindly evict on every call regardless of outcome.
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
    // The allowlist/registry gate runs before any I/O or cache touch, so an
    // unknown module throws *before* it could evict the cache — proven here by
    // a populated cache surviving three different failing module writes.

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

    // Force the mtime a minute into the future rather than rewriting the file:
    // a same-millisecond rewrite could collide with the recorded mtime and flake
    // on coarse filesystems, so we move the clock unambiguously forward.
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
    // An entry set with no tracked files has nothing to compare against, so it
    // can only be dropped by an explicit invalidate — never by mtime drift.
    const cache = new ResolvedConfigCache<{ v: number }>();
    cache.set('/proj', { v: 1 });
    expect(cache.get('/proj')).toEqual({ v: 1 });
  });

  it('composeResolvedConfig reflects a hand-edit to project.md on the next read', async () => {
    const { projectRoot, userHome } = makeFixture();
    const overlayPath = path.join(projectRoot, '.claude', 'gan', 'project.md');

    const before = await composeResolvedConfig(projectRoot, { userHome });
    const beforePlanner = before.overlay['planner'] as
      | { additionalContext?: unknown }
      | undefined;
    expect(beforePlanner?.additionalContext).toBeUndefined();

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

    const futureSec = Date.now() / 1000 + 60;
    utimesSync(overlayPath, futureSec, futureSec);

    const after = await composeResolvedConfig(projectRoot, { userHome });
    const afterPlanner = after.overlay['planner'] as
      | { additionalContext?: unknown }
      | undefined;
    expect(afterPlanner?.additionalContext).toEqual(['docs/intro.md']);
  });

  it('composeResolvedConfig picks up a brand-new higher-tier stack shadow', async () => {
    // The fixture's web-node starts as a builtin-tier stack; writing a
    // project-tier copy under .claude/gan/stacks should "shadow" it. This
    // proves invalidation fires for a file that did not previously exist
    // (tracked-absent → present), promoting the resolved tier builtin→project.
    const { projectRoot, userHome } = makeFixture();
    const stacksDir = path.join(projectRoot, '.claude', 'gan', 'stacks');
    const shadowPath = path.join(stacksDir, 'web-node.md');

    const before = await composeResolvedConfig(projectRoot, { userHome });
    const webNodeBefore = before.stacks.byName['web-node'];
    expect(webNodeBefore?.tier).toBe('builtin');

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

    const after = await composeResolvedConfig(projectRoot, { userHome });
    const webNodeAfter = after.stacks.byName['web-node'];
    expect(webNodeAfter?.tier).toBe('project');
    expect(webNodeAfter?.path.endsWith('/.claude/gan/stacks/web-node.md')).toBe(true);
  });
});

describe('F5 slice 4 — schemas/api-tools-v1.json agrees with runtime validators', () => {
  // Data-driven: one pair of assertions per advertised tool, so a newly-added
  // tool is automatically covered and a schema/runtime mismatch names the
  // offending tool in the failure rather than failing one opaque aggregate.
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
