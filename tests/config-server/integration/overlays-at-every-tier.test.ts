/**
 * R1 sprint 7 integration test — C4 cascade end to end at every tier.
 *
 * Builds a temp-dir fixture where each of default/user/project tiers
 * contributes a value to the cascade. Verifies:
 *
 *   - Per the C4 worked rule: lower `[A,B,C]` + higher `[X,B',Y]` resolves
 *     to `[A,B',C,X,Y]`. We exercise this on
 *     `proposer.additionalCriteria` (a `list-union-by-key-name` rule).
 *   - Scalar override: `runner.thresholdOverride` from the leaf tier wins.
 *   - Tier provenance is faithfully reflected in the resolved config.
 *
 * The fixture is constructed in a temp directory so the test does not
 * mutate any committed fixture and runs hermetically across CI shards.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getResolvedConfig } from '../../../src/config-server/tools/reads.js';
import { validateAll } from '../../../src/config-server/tools/validate.js';
import { clearResolvedConfigCache } from '../../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimalSrc = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

const tmpDirs: string[] = [];

function makeTmpProjectAndUserHome(): {
  projectRoot: string;
  userHome: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'cas-overlays-'));
  const projectRoot = path.join(root, 'project');
  const userHome = path.join(root, 'home');
  cpSync(jsTsMinimalSrc, projectRoot, { recursive: true });
  mkdirSync(path.join(userHome, '.claude', 'gan'), { recursive: true });
  tmpDirs.push(root);
  return { projectRoot, userHome };
}

function writeOverlay(filePath: string, body: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, body);
}

beforeEach(() => clearResolvedConfigCache());

afterEach(() => {
  clearResolvedConfigCache();
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('integration: overlays at every tier (C4 cascade)', () => {
  it('runs the C4 worked rule on a list field and a scalar override', async () => {
    const { projectRoot, userHome } = makeTmpProjectAndUserHome();

    // Default tier (lowest): contributes A, B, C with thresholdOverride 50.
    writeOverlay(
      path.join(projectRoot, '.claude', 'gan', 'default.md'),
      `---
schemaVersion: 1
proposer:
  additionalCriteria:
    - name: A
      description: from-default
      threshold: 1
    - name: B
      description: from-default
      threshold: 2
    - name: C
      description: from-default
      threshold: 3
runner:
  thresholdOverride: 50
---
`,
    );

    // User tier (middle): contributes nothing extra to the list, raises
    // thresholdOverride to 75.
    writeOverlay(
      path.join(userHome, '.claude', 'gan', 'user.md'),
      `---
schemaVersion: 1
runner:
  thresholdOverride: 75
---
`,
    );

    // Project tier (leaf, highest): replaces B in-place with B', adds X, Y,
    // and pushes thresholdOverride to 90.
    writeOverlay(
      path.join(projectRoot, '.claude', 'gan', 'project.md'),
      `---
schemaVersion: 1
proposer:
  additionalCriteria:
    - name: X
      description: from-project
      threshold: 10
    - name: B
      description: from-project-overrides-default
      threshold: 20
    - name: Y
      description: from-project
      threshold: 30
runner:
  thresholdOverride: 90
---
`,
    );

    // Pre-condition: validateAll should be clean (no schema mismatches,
    // no invariants tripped).
    const validation = validateAll({ projectRoot }, { userHome });
    expect(validation.issues).toEqual([]);

    const r = await getResolvedConfig({ projectRoot }, { userHome });

    // Assert C4 worked rule on the list field: [A, B', C, X, Y].
    const merged = r.overlay as Record<string, Record<string, unknown>>;
    const criteria = merged.proposer.additionalCriteria as Array<{
      name: string;
      description: string;
      threshold: number;
    }>;
    expect(criteria.map((c) => c.name)).toEqual(['A', 'B', 'C', 'X', 'Y']);
    // B' replaced B in-place: the description tells us which tier won.
    const b = criteria.find((c) => c.name === 'B');
    expect(b?.description).toBe('from-project-overrides-default');

    // Assert scalar override: project tier wins (90).
    expect(merged.runner.thresholdOverride).toBe(90);

    // Tier provenance is implicit in the cascade output (the higher-tier
    // entry's data won), but we also assert that the cascade marked
    // nothing as discarded — this is a pure additive cascade.
    expect(r.discarded).toEqual([]);
  });
});
