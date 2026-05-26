// End-to-end coverage of the overlay-misuse warning surface against on-disk
// fixtures, driven through the two entry points that compute and carry it:
// `validateAll` (the diagnostic surface where warnings are computed) and
// `getResolvedConfig` (the snapshot surface that exposes the same warnings).
//
// The fixtures use a synthetic `php-grav` stack (not a shipped stack) so a
// multi-stack auto-detection result can be compared against a narrower
// `stack.override`. Each fixture isolates one acceptance scenario: shrinkage,
// override-equals-detection, single-stack detection, and the generic-fallback
// edge case.
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

  describe('lifecycle', () => {
    it('warnings never abort validateAll (it returns data, does not throw)', () => {
      expect(() => validateAll({ projectRoot: fx('overlay-warn-shrinkage') })).not.toThrow();
    });

    it('a warning rides a successfully-validating project (orthogonal to the error path)', () => {
      // The shrinkage fixture is schema-clean, so the warning is the only signal
      // and it is carried on a zero-issue validation — proving warnings never
      // turn a clean validation into a failed one.
      const { issues, warnings } = validateAll({ projectRoot: fx('overlay-warn-shrinkage') });
      expect(issues).toEqual([]);
      expect(warnings.some((w) => w.code === 'StackOverrideShrinkage')).toBe(true);
    });
  });
});
