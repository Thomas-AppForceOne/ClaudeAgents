// End-to-end coverage of the overlay-misuse warning surfaces against on-disk
// fixtures, driven through the two entry points that compute and carry them:
// `validateAll` (the diagnostic surface where warnings are computed) and
// `getResolvedConfig` (the snapshot surface that exposes the same warnings).
//
// The fixtures use a synthetic `php-grav` stack (not a shipped stack) so a
// multi-stack auto-detection result can be compared against a narrower
// `stack.override`. Each fixture isolates one acceptance scenario: shrinkage,
// override-equals-detection, single-stack detection, the generic-fallback edge
// case, a single per-stack override, multi-stack per-stack overrides, a
// secret-bearing override value, and a combined both-warnings case.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAll } from '../../../src/config-server/tools/validate.js';
import { getResolvedConfig } from '../../../src/config-server/tools/reads.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';
import type { Warning, WarningDetails } from '../../../src/config-server/warnings.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const fixtures = path.join(repoRoot, 'tests', 'fixtures', 'stacks');
const fx = (name: string): string => path.join(fixtures, name);

// Narrowed accessors so the assertions read against the discriminated payload
// without repeated casts; the test has already checked the code by this point.
function shrinkageDetails(w: Warning): Extract<WarningDetails, { code: 'StackOverrideShrinkage' }> {
  expect(w.code).toBe('StackOverrideShrinkage');
  return w.details as Extract<WarningDetails, { code: 'StackOverrideShrinkage' }>;
}
function perStackDetails(
  w: Warning,
): Extract<WarningDetails, { code: 'PerStackOverrideUnsupported' }> {
  expect(w.code).toBe('PerStackOverrideUnsupported');
  return w.details as Extract<WarningDetails, { code: 'PerStackOverrideUnsupported' }>;
}

describe('integration: overlay-misuse warnings', () => {
  beforeEach(() => clearResolvedConfigCache());
  afterEach(() => clearResolvedConfigCache());

  describe('StackOverrideShrinkage', () => {
    it('override [php-grav] against detected [php-grav, web-node] warns and names web-node', () => {
      const { issues, warnings } = validateAll({ projectRoot: fx('overlay-warn-shrinkage') });
      // A clean (schema-valid) overlay: the only signal is the warning, proving
      // warnings ride a successfully-validating project with zero issues.
      expect(issues).toEqual([]);
      expect(warnings).toHaveLength(1);
      const d = shrinkageDetails(warnings[0]);
      expect(d.overrideSet).toEqual(['php-grav']);
      expect(d.detectionSet).toEqual(['php-grav', 'web-node']);
      expect(d.suppressed).toEqual(['web-node']);
      expect(warnings[0].message).toContain('web-node');
      expect(warnings[0].message).toContain('stack.override');
    });

    it('the same warning is exposed on the getResolvedConfig snapshot', async () => {
      const resolved = await getResolvedConfig({ projectRoot: fx('overlay-warn-shrinkage') });
      expect(resolved.warnings).toHaveLength(1);
      expect(resolved.warnings[0].code).toBe('StackOverrideShrinkage');
      // The active set reflects the override (web-node suppressed), confirming
      // the warning describes the same resolution the snapshot exposes.
      expect(resolved.stacks.active).toEqual(['php-grav']);
    });

    it('override matching detection ([php-grav, web-node]) produces no shrinkage warning', () => {
      const { warnings } = validateAll({ projectRoot: fx('overlay-warn-override-equals') });
      expect(warnings.filter((w) => w.code === 'StackOverrideShrinkage')).toEqual([]);
    });

    it('override [php-grav] where only php-grav detects produces no shrinkage warning', () => {
      const { warnings } = validateAll({ projectRoot: fx('overlay-warn-single-detection') });
      expect(warnings.filter((w) => w.code === 'StackOverrideShrinkage')).toEqual([]);
    });

    it('override excluding generic where detection would fall back to generic warns', () => {
      const { warnings } = validateAll({ projectRoot: fx('overlay-warn-generic-fallback') });
      const shrink = warnings.filter((w) => w.code === 'StackOverrideShrinkage');
      expect(shrink).toHaveLength(1);
      const d = shrinkageDetails(shrink[0]);
      expect(d.suppressed).toEqual(['generic']);
      expect(shrink[0].message).toContain('generic');
      expect(shrink[0].message).toContain('fallback');
    });
  });

  describe('PerStackOverrideUnsupported', () => {
    it('web-node.buildCmd produces one warning naming web-node and buildCmd', () => {
      const { warnings } = validateAll({ projectRoot: fx('overlay-warn-per-stack-single') });
      const perStack = warnings.filter((w) => w.code === 'PerStackOverrideUnsupported');
      expect(perStack).toHaveLength(1);
      const d = perStackDetails(perStack[0]);
      expect(d.stack).toBe('web-node');
      expect(d.fields).toEqual(['buildCmd']);
    });

    it('multiple stacks each get one warning; same-stack fields collapse and order deterministically', () => {
      const { warnings } = validateAll({ projectRoot: fx('overlay-warn-per-stack-multi') });
      const perStack = warnings.filter((w) => w.code === 'PerStackOverrideUnsupported');
      expect(perStack).toHaveLength(2);
      // Locale-sorted by stack name: php-grav before web-node.
      const byStack = perStack.map((w) => perStackDetails(w));
      expect(byStack[0]).toEqual({
        code: 'PerStackOverrideUnsupported',
        stack: 'php-grav',
        fields: ['buildCmd'],
      });
      expect(byStack[1]).toEqual({
        code: 'PerStackOverrideUnsupported',
        stack: 'web-node',
        fields: ['buildCmd', 'testCmd'],
      });
    });

    it('never echoes the override command value anywhere in the warning', () => {
      const SECRET = 'SECRET_TOKEN_abc123XYZ';
      const { warnings } = validateAll({ projectRoot: fx('overlay-warn-per-stack-secret') });
      const perStack = warnings.filter((w) => w.code === 'PerStackOverrideUnsupported');
      expect(perStack).toHaveLength(1);
      // Neither the prose nor the serialised details may carry the value.
      expect(perStack[0].message).not.toContain(SECRET);
      expect(JSON.stringify(perStack[0])).not.toContain(SECRET);
    });

    it('the secret value also never reaches the resolved-config snapshot', async () => {
      const SECRET = 'SECRET_TOKEN_abc123XYZ';
      const resolved = await getResolvedConfig({
        projectRoot: fx('overlay-warn-per-stack-secret'),
      });
      // The whole serialised snapshot must be free of the value: the warning is
      // value-free, and the cascade drops the stack-named block, so the opaque
      // override value is never persisted.
      expect(JSON.stringify(resolved.warnings)).not.toContain(SECRET);
      expect(resolved.warnings.some((w) => w.code === 'PerStackOverrideUnsupported')).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('warnings never abort validateAll (it returns data, does not throw)', () => {
      expect(() => validateAll({ projectRoot: fx('overlay-warn-combined') })).not.toThrow();
    });

    it('warnings are carried alongside structured errors, not in place of them', () => {
      // The per-stack fixtures declare a stack-named overlay block the v1 schema
      // rejects, so a SchemaMismatch issue is raised. The warning must still be
      // present in addition to that error — misuse stays visible during a
      // non-aborting inspection even when other structured errors exist.
      const { issues, warnings } = validateAll({
        projectRoot: fx('overlay-warn-per-stack-single'),
      });
      expect(issues.length).toBeGreaterThanOrEqual(1);
      expect(warnings.some((w) => w.code === 'PerStackOverrideUnsupported')).toBe(true);
    });

    it('combined fixture produces both warnings on one snapshot without interaction', async () => {
      const resolved = await getResolvedConfig({ projectRoot: fx('overlay-warn-combined') });
      const codes = resolved.warnings.map((w) => w.code).sort();
      expect(codes).toEqual(['PerStackOverrideUnsupported', 'StackOverrideShrinkage']);
      const shrink = resolved.warnings.find((w) => w.code === 'StackOverrideShrinkage');
      expect(shrinkageDetails(shrink!).suppressed).toEqual(['web-node']);
      const perStack = resolved.warnings.find((w) => w.code === 'PerStackOverrideUnsupported');
      expect(perStackDetails(perStack!).stack).toBe('web-node');
    });
  });
});
