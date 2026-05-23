/**
 * Multi-stack guard rail: a project where two stacks (`web-node` and a
 * synthetic second stack) are simultaneously active. The core invariant is
 * isolation — when several stacks resolve at once, each stack's fields stay
 * with that stack and never cross-contaminate the other.
 *
 * Coverage:
 *   - a clean polyglot fixture validates with zero issues;
 *   - the active set is the deterministic union (sorted) of both stack names,
 *     each reported with `builtin` tier provenance;
 *   - per-stack reads (scope, securitySurfaces, cacheEnv) are mutually
 *     exclusive — the explicit cross-checks assert no surface id from one stack
 *     appears in the other;
 *   - the synthetic stack is intentionally maximal: it exercises *every* C1
 *     schema field (anyOf/allOf detection, scope, secretsGlob, cacheEnv,
 *     auditCmd absence signalling, build/test/lint commands, and both
 *     keyword+scope and scope-only security-surface triggers), so a field the
 *     resolver silently drops shows up as a failure here.
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

    expect(webNode.sourceTier).toBe('builtin');
    expect(synthetic.sourceTier).toBe('builtin');

    expect(webData.scope).toEqual(['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']);
    expect(synData.scope).toEqual(['synthetic/**']);

    const webSurfaces = (webData.securitySurfaces as Array<{ id: string }>).map((s) => s.id);
    const synSurfaces = (synData.securitySurfaces as Array<{ id: string }>).map((s) => s.id);
    expect(webSurfaces).toEqual(['prototype_pollution']);
    expect(synSurfaces).toEqual(['synthetic_keyword_surface', 'synthetic_scope_only_surface']);
    // No-cross-contamination: neither stack's surface ids may bleed into the
    // other's resolved data when both are active at once.
    for (const s of synSurfaces) expect(webSurfaces).not.toContain(s);
    for (const s of webSurfaces) expect(synSurfaces).not.toContain(s);

    const webCache = webData.cacheEnv as Array<{ envVar: string }>;
    const synCache = synData.cacheEnv as Array<{ envVar: string }>;
    expect(webCache.map((e) => e.envVar)).toEqual(['NPM_CONFIG_CACHE']);
    expect(synCache.map((e) => e.envVar)).toEqual(['SYNTHETIC_CACHE_HOME']);
  });

  it('synthetic-second exercises every C1 schema field (multi-stack guard rail)', () => {
    const stack = getStack({ projectRoot: polyglotFixture, name: 'synthetic-second' });
    const data = stack.data as Record<string, unknown>;

    expect(data.name).toBe('synthetic-second');
    expect(data.schemaVersion).toBe(1);

    // The synthetic stack's detection rules deliberately include both an
    // `anyOf` and an `allOf` clause so both detection combinators are covered.
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

    expect((data.scope as unknown[]).length).toBeGreaterThan(0);
    expect((data.secretsGlob as unknown[]).length).toBeGreaterThan(0);
    expect((data.cacheEnv as unknown[]).length).toBeGreaterThan(0);

    const audit = data.auditCmd as Record<string, unknown>;
    expect(audit.absenceSignal).toBe('warning');
    expect(typeof audit.absenceMessage).toBe('string');

    expect(typeof data.buildCmd).toBe('string');
    expect(typeof data.testCmd).toBe('string');
    expect(typeof data.lintCmd).toBe('string');

    const surfaces = data.securitySurfaces as Array<{
      id: string;
      triggers?: { keywords?: string[]; scope?: string[] };
    }>;
    // Both trigger shapes must be present: one surface gated on keywords AND
    // scope, and one gated on scope alone (no keywords) — so the resolver is
    // proven to preserve each variant rather than normalising them together.
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
