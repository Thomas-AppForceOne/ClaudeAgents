/**
 * The C4 cascade worked example: overlays present at all three tiers
 * (default, user, project) and merged into one resolved overlay. This suite is
 * the canonical proof of the two distinct merge semantics, exercised in a
 * single resolve so their interaction is also covered:
 *
 *   - list fields (proposer.additionalCriteria) APPEND across tiers in
 *     default→user→project order, with same-named entries overridden by the
 *     higher tier in place (not duplicated, not reordered);
 *   - scalar fields (runner.thresholdOverride) are last-writer-wins, where
 *     "last" is the highest precedence tier.
 *
 * The fixture is deliberately constructed so the answer is unambiguous: the
 * criteria list resolves to [A, B, C, X, Y] (defaults A/B/C first, project's
 * new X/Y appended, B's description taken from the project tier), and the
 * scalar resolves to 90 (project) despite default=50 and user=75. `discarded`
 * must stay empty — a non-empty discarded list would mean an entry was dropped
 * rather than merged, which is the regression this guards.
 *
 * The default and project overlays are written into the project tree; the user
 * overlay is written into a separate temp home so the `user` tier is resolved
 * from a real, isolated home directory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMergedSplicePoints, getResolvedConfig } from '../../../src/config-server/tools/reads.js';
import { validateAll } from '../../../src/config-server/tools/validate.js';
import { resolveEffectiveSafetyConfig, readSafetyOverlayBlock } from '../../../src/safety/index.js';
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

    writeOverlay(
      path.join(userHome, '.claude', 'gan', 'user.md'),
      `---
schemaVersion: 1
runner:
  thresholdOverride: 75
---
`,
    );

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

    const validation = validateAll({ projectRoot }, { userHome });
    expect(validation.issues).toEqual([]);

    const r = await getResolvedConfig({ projectRoot }, { userHome });

    const merged = r.overlay as Record<string, Record<string, unknown>>;
    const criteria = merged.proposer.additionalCriteria as Array<{
      name: string;
      description: string;
      threshold: number;
    }>;
    // List merge: defaults A,B,C come first (in order), then project adds the
    // new X,Y appended at the tail. B is not duplicated — it is overridden in
    // place — so the final order is A,B,C,X,Y.
    expect(criteria.map((c) => c.name)).toEqual(['A', 'B', 'C', 'X', 'Y']);

    // ...and the overridden B carries the higher (project) tier's description,
    // proving the override replaced the default entry rather than co-existing.
    const b = criteria.find((c) => c.name === 'B');
    expect(b?.description).toBe('from-project-overrides-default');

    // Scalar merge: last-writer-wins by precedence — project's 90 beats user's
    // 75 and default's 50.
    expect(merged.runner.thresholdOverride).toBe(90);

    // Nothing was dropped: a non-empty discarded list would signal a merge bug.
    expect(r.discarded).toEqual([]);
  });

  it('surfaces merged safety.* through getResolvedConfig and getMergedSplicePoints (A1)', async () => {
    const { projectRoot, userHome } = makeTmpProjectAndUserHome();

    // user sets a base ceiling map; project raises one role and sets the two
    // scalars — proving attemptCeilings merges per-role across tiers while the
    // scalars are last-writer-wins by precedence.
    writeOverlay(
      path.join(userHome, '.claude', 'gan', 'user.md'),
      `---
schemaVersion: 1
safety:
  attemptCeilings:
    gan-contract-proposer: 4
    gan-generator: 4
  sprintBudget: 15
---
`,
    );
    writeOverlay(
      path.join(projectRoot, '.claude', 'gan', 'project.md'),
      `---
schemaVersion: 1
safety:
  attemptCeilings:
    gan-generator: 6
  oscillationDetection: false
---
`,
    );

    const validation = validateAll({ projectRoot }, { userHome });
    expect(validation.issues).toEqual([]);

    const r = await getResolvedConfig({ projectRoot }, { userHome });
    const merged = r.overlay as Record<string, Record<string, unknown>>;
    expect(merged.safety.attemptCeilings).toEqual({
      'gan-contract-proposer': 4, // survives from the user tier
      'gan-generator': 6, // project tier wins the shared key
    });
    expect(merged.safety.sprintBudget).toBe(15); // user tier (project did not set it)
    expect(merged.safety.oscillationDetection).toBe(false); // project tier
    expect(r.discarded).toEqual([]);

    // getMergedSplicePoints surfaces the same block, and the resolver folds it
    // (over the seed defaults) into the effective config the orchestrator uses.
    const { mergedSplicePoints } = getMergedSplicePoints({ projectRoot }, { userHome });
    const eff = resolveEffectiveSafetyConfig({ overlay: readSafetyOverlayBlock(mergedSplicePoints) });
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 4, 'gan-generator': 6 });
    expect(eff.sprintBudget).toBe(15);
    expect(eff.oscillationDetection).toBe(false);
  });

  it('empty overlay resolves with no hollow safety block (A1 additive guarantee)', async () => {
    const { projectRoot, userHome } = makeTmpProjectAndUserHome();
    // No overlay files written at all → empty overlay for this project.

    const validation = validateAll({ projectRoot }, { userHome });
    expect(validation.issues).toEqual([]);

    const r = await getResolvedConfig({ projectRoot }, { userHome });
    const merged = r.overlay as Record<string, unknown>;
    // The three new fields are absent ⇒ no safety block is materialised (empty
    // blocks are pruned), and the resolver yields exactly the sprint-1..4 seeds.
    expect(merged.safety).toBeUndefined();
    expect(r.issues).toEqual([]);

    const { mergedSplicePoints } = getMergedSplicePoints({ projectRoot }, { userHome });
    const eff = resolveEffectiveSafetyConfig({ overlay: readSafetyOverlayBlock(mergedSplicePoints) });
    expect(eff.attemptCeilings).toEqual({ 'gan-contract-proposer': 3, 'gan-generator': 3 });
    expect(eff.sprintBudget).toBe(12);
    expect(eff.oscillationDetection).toBe(true);
  });
});
