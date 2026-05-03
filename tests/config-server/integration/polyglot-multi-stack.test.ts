/**
 * R1 sprint 7 integration test — multi-stack guard rail.
 *
 * Validates the polyglot fixture (`web-node` + `synthetic-second`) end to
 * end:
 *
 *   1. `validateAll` returns zero issues — the fixture is designed to
 *      satisfy every R1 invariant (no schema-mismatch, no detection
 *      tier-1/2 leak, no cacheEnv conflict, no path escape, etc.).
 *   2. `getResolvedConfig` reports both stacks as active with builtin
 *      tier provenance.
 *   3. Per the dispatch invariants in PROJECT_CONTEXT.md, both stacks'
 *      data is exposed via `getStack` (active-set union), and stack-
 *      scoped fields (`securitySurfaces`, `scope`, `secretsGlob`) are
 *      keyed under the stack that owns them — no cross-contamination
 *      across ecosystems.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../../src/config-server/tools/validate.js';
import {
  getActiveStacks,
  getResolvedConfig,
  getStack,
} from '../../../src/config-server/tools/reads.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const polyglotFixture = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'stacks',
  'polyglot-webnode-synthetic',
);

describe('integration: polyglot multi-stack guard rail', () => {
  beforeEach(() => clearResolvedConfigCache());
  afterEach(() => clearResolvedConfigCache());

  it('validateAll returns zero issues for the polyglot fixture', () => {
    const result = validateAll({ projectRoot: polyglotFixture });
    expect(result.issues).toEqual([]);
  });

  it('getResolvedConfig reports both stacks active with builtin tier provenance', async () => {
    const r = await getResolvedConfig({ projectRoot: polyglotFixture });
    expect(r.stacks.active).toEqual(['synthetic-second', 'web-node']);
    expect(r.stacks.byName['web-node']).toMatchObject({
      tier: 'builtin',
      schemaVersion: 1,
    });
    expect(r.stacks.byName['web-node'].path).toContain('web-node.md');
    expect(r.stacks.byName['synthetic-second']).toMatchObject({
      tier: 'builtin',
      schemaVersion: 1,
    });
    expect(r.stacks.byName['synthetic-second'].path).toContain('synthetic-second.md');
    expect(r.issues).toEqual([]);
  });

  it('getActiveStacks union: returns both stack names', () => {
    const result = getActiveStacks({ projectRoot: polyglotFixture });
    expect(result.active).toEqual(['synthetic-second', 'web-node']);
  });

  it('union semantics: both stacks fields appear via getStack with no cross-contamination', () => {
    const webNode = getStack({ projectRoot: polyglotFixture, name: 'web-node' });
    const synthetic = getStack({ projectRoot: polyglotFixture, name: 'synthetic-second' });

    const webData = webNode.data as Record<string, unknown>;
    const synData = synthetic.data as Record<string, unknown>;

    // Both stacks resolve from the built-in tier.
    expect(webNode.sourceTier).toBe('builtin');
    expect(synthetic.sourceTier).toBe('builtin');

    // Each stack carries its own `scope`. No overlap: web-node owns
    // **/*.{ts,tsx,js,jsx}; synthetic-second owns synthetic/**.
    expect(webData.scope).toEqual(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']);
    expect(synData.scope).toEqual(['synthetic/**']);

    // Each stack carries its own `securitySurfaces`. No surface from
    // web-node leaks into synthetic-second's record (or vice versa).
    const webSurfaces = (webData.securitySurfaces as Array<{ id: string }>).map((s) => s.id);
    const synSurfaces = (synData.securitySurfaces as Array<{ id: string }>).map((s) => s.id);
    expect(webSurfaces).toEqual(['prototype_pollution']);
    expect(synSurfaces).toEqual(['synthetic_keyword_surface', 'synthetic_scope_only_surface']);
    for (const s of synSurfaces) expect(webSurfaces).not.toContain(s);
    for (const s of webSurfaces) expect(synSurfaces).not.toContain(s);

    // Each stack carries its own `cacheEnv` envVar — neither overlaps,
    // confirming cacheEnv conflict-resolution had nothing to do.
    const webCache = webData.cacheEnv as Array<{ envVar: string }>;
    const synCache = synData.cacheEnv as Array<{ envVar: string }>;
    expect(webCache.map((e) => e.envVar)).toEqual(['NPM_CONFIG_CACHE']);
    expect(synCache.map((e) => e.envVar)).toEqual(['SYNTHETIC_CACHE_HOME']);
  });

  it('synthetic-second exercises every C1 schema field (multi-stack guard rail)', () => {
    const stack = getStack({ projectRoot: polyglotFixture, name: 'synthetic-second' });
    const data = stack.data as Record<string, unknown>;
    // Frontmatter:
    expect(data.name).toBe('synthetic-second');
    expect(data.schemaVersion).toBe(1);
    // Composite detection (allOf + anyOf both present):
    const detection = data.detection as unknown[];
    expect(Array.isArray(detection)).toBe(true);
    const hasAnyOf = detection.some(
      (e) => typeof e === 'object' && e !== null && 'anyOf' in (e as Record<string, unknown>),
    );
    const hasAllOf = detection.some(
      (e) => typeof e === 'object' && e !== null && 'allOf' in (e as Record<string, unknown>),
    );
    expect(hasAnyOf).toBe(true);
    expect(hasAllOf).toBe(true);
    // scope, secretsGlob, cacheEnv:
    expect((data.scope as unknown[]).length).toBeGreaterThan(0);
    expect((data.secretsGlob as unknown[]).length).toBeGreaterThan(0);
    expect((data.cacheEnv as unknown[]).length).toBeGreaterThan(0);
    // auditCmd with non-silent absenceSignal + absenceMessage:
    const audit = data.auditCmd as Record<string, unknown>;
    expect(audit.absenceSignal).toBe('warning');
    expect(typeof audit.absenceMessage).toBe('string');
    // Three command fields present:
    expect(typeof data.buildCmd).toBe('string');
    expect(typeof data.testCmd).toBe('string');
    expect(typeof data.lintCmd).toBe('string');
    // Surfaces with both keyword + scope triggers, AND scope-only:
    const surfaces = data.securitySurfaces as Array<{
      id: string;
      triggers?: { keywords?: string[]; scope?: string[] };
    }>;
    const keywordAndScope = surfaces.find(
      (s) =>
        Array.isArray(s.triggers?.keywords) &&
        Array.isArray(s.triggers?.scope) &&
        (s.triggers!.keywords as string[]).length > 0 &&
        (s.triggers!.scope as string[]).length > 0,
    );
    const scopeOnly = surfaces.find(
      (s) => Array.isArray(s.triggers?.scope) && !s.triggers?.keywords,
    );
    expect(keywordAndScope).toBeTruthy();
    expect(scopeOnly).toBeTruthy();
  });
});
