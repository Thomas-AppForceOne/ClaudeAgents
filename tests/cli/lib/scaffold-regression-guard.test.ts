// R6 closing-guard regression suite for the scaffold. It exists to pin the
// exact way the R6 change NARROWED the un-edited-scaffold failure rather than
// removing it: detection was dropped from the scaffold body, so the failure of
// an un-edited scaffold must now be attributable to the TODO stubs / DRAFT
// banner ONLY — never to a detection.tier3_only invariant (F3) or a C1
// `/detection` parse rejection, both of which would mean detection sneaked back
// in. It also guards that a fully-edited scaffold validates with zero residual
// invariants, that the frontmatter carries no `detection` key, and — by reading
// the actual source of stacks-new.ts and scaffold.ts — that tier→body selection
// stays centralised in a single `buildScaffold(name, tier)` call rather than
// per-tier branching at the call site.

import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildScaffold, DRAFT_BANNER } from '../../../src/cli/lib/scaffold.js';
import {
  validateStackBodyAgainstSchema,
  type Issue,
} from '../../../src/config-server/validation/schema-check.js';
import { checkDetectionTier3Only } from '../../../src/config-server/invariants/detection-tier3-only.js';
import type { ValidationSnapshot } from '../../../src/config-server/tools/validate.js';
import {
  SCAFFOLD_SECOND_LINE as SECOND_LINE,
  scaffoldFrontmatter as frontmatter,
  editedScaffoldBody as editedBody,
  stripScaffoldBanner as stripBannerBlock,
} from '../helpers/scaffold-edit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const TIERS = ['project', 'user'] as const;
type Tier = (typeof TIERS)[number];

// Run the structural checks the real validator runs against one stack body:
// schema validation plus the detection.tier3_only invariant. The snapshot is
// hand-built (cast through unknown) since only `stackFiles` is consulted; the
// virtual path embeds the tier so map keys are unique per tier.
function structuralIssues(
  name: string,
  tier: Tier,
  data: Record<string, unknown>,
): Issue[] {
  const virtualPath = `/virtual/${tier}/${name}.md`;
  const issues: Issue[] = [];
  validateStackBodyAgainstSchema(virtualPath, data, issues);
  const snapshot = {
    stackFiles: new Map([
      [`${tier}:${virtualPath}`, { tier, path: virtualPath, data }],
    ]),
  } as unknown as ValidationSnapshot;
  issues.push(...checkDetectionTier3Only(snapshot));
  return issues;
}

// True iff the F3 detection.tier3_only invariant fired: an InvariantViolation
// pinned to the `/detection` field. Its ABSENCE is what most tests assert.
function hasDetectionTier3Invariant(issues: Issue[]): boolean {
  return issues.some(
    (i) => i.code === 'InvariantViolation' && (i.field ?? '') === '/detection',
  );
}

// True iff the C1 schema layer rejected something under `/detection` — i.e.
// detection was present in the body and failed to parse. Also expected to be
// absent now that the scaffold emits no detection at all.
function hasC1DetectionParseRejection(issues: Issue[]): boolean {
  return issues.some(
    (i) =>
      i.code === 'SchemaMismatch' &&
      (i.field ?? '').startsWith('/detection'),
  );
}

describe('R6 closing guard — un-edited scaffold still fails (narrowed, not removed)', () => {
  for (const tier of TIERS) {
    it(`un-edited ${tier}-tier scaffold STILL fails validation`, () => {
      const out = buildScaffold('acme-svc', tier);
      const issues = structuralIssues('acme-svc', tier, frontmatter(out));

      expect(issues.length).toBeGreaterThan(0);
    });

    it(`un-edited ${tier}-tier failure is attributable to the TODO stubs`, () => {
      const out = buildScaffold('acme-svc', tier);
      const issues = structuralIssues('acme-svc', tier, frontmatter(out));

      const schemaIssues = issues.filter((i) => i.code === 'SchemaMismatch');
      expect(schemaIssues.length).toBeGreaterThan(0);

      const nonBlank = out.split('\n').filter((l) => l.trim().length > 0);
      expect(nonBlank[0]).toBe(DRAFT_BANNER);
      expect(nonBlank[1]).toBe(SECOND_LINE);
      expect(out).toContain('"TODO/**/*"');
      expect(out).toContain('false  # TODO: replace before committing');
    });

    it(`un-edited ${tier}-tier failure does NOT include detection.tier3_only`, () => {
      const out = buildScaffold('acme-svc', tier);
      const issues = structuralIssues('acme-svc', tier, frontmatter(out));
      expect(hasDetectionTier3Invariant(issues)).toBe(false);
    });

    it(`un-edited ${tier}-tier failure does NOT include a C1 detection parse rejection`, () => {
      const out = buildScaffold('acme-svc', tier);
      const issues = structuralIssues('acme-svc', tier, frontmatter(out));
      expect(hasC1DetectionParseRejection(issues)).toBe(false);
    });
  }
});

describe('R6 closing guard — edited scaffold passes with zero residual invariants', () => {
  for (const tier of TIERS) {
    it(`fully-edited ${tier}-tier scaffold validates with ZERO errors`, () => {
      const issues = structuralIssues('acme-svc', tier, editedBody('acme-svc', tier));
      expect(
        issues,
        `expected zero validation issues, got: ${JSON.stringify(issues, null, 2)}`,
      ).toEqual([]);
    });

    it(`fully-edited ${tier}-tier scaffold: no detection.tier3_only InvariantViolation (named)`, () => {

      const issues = structuralIssues('acme-svc', tier, editedBody('acme-svc', tier));
      expect(hasDetectionTier3Invariant(issues)).toBe(false);
      expect(
        issues.some((i) => i.code === 'InvariantViolation'),
      ).toBe(false);
    });

    it(`fully-edited ${tier}-tier scaffold: parses cleanly under C1 (no /detection parse rejection)`, () => {
      const issues = structuralIssues('acme-svc', tier, editedBody('acme-svc', tier));
      expect(hasC1DetectionParseRejection(issues)).toBe(false);

      expect(issues.some((i) => i.code === 'SchemaMismatch')).toBe(false);
    });

    it(`scaffold frontmatter has NO detection key (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      const fm = frontmatter(out);
      expect('detection' in fm).toBe(false);

      expect(out).not.toMatch(/^\s*detection\s*:/m);
    });

    it(`textual first-edit pass removes the DRAFT banner block (${tier} tier)`, () => {
      const stripped = stripBannerBlock(buildScaffold('acme-svc', tier));
      expect(stripped).not.toContain(DRAFT_BANNER);
      expect(stripped).not.toContain(SECOND_LINE);
    });
  }
});

describe('R6 closing guard — tier→body selection stays centralised in buildScaffold', () => {
  it('the two tiers differ ONLY in the activation-comment overlay phrase', () => {
    const proj = buildScaffold('acme-svc', 'project');
    const user = buildScaffold('acme-svc', 'user');
    expect(proj).not.toBe(user);
    const normalise = (s: string): string =>
      s
        .replace('project overlay (.claude/gan/project.md)', 'OVERLAY')
        .replace('user overlay (~/.claude/gan/user.md)', 'OVERLAY')
        .replace('# This stack is project-tier:', '# This stack is TIER:')
        .replace('# This stack is user-tier:', '# This stack is TIER:');
    expect(normalise(proj)).toBe(normalise(user));
  });

  it('buildScaffold is pure & byte-deterministic for both tiers', () => {
    for (const tier of TIERS) {
      expect(buildScaffold('acme-svc', tier)).toBe(buildScaffold('acme-svc', tier));
    }
  });

  it('stacks-new.ts calls buildScaffold exactly once, with the resolved tier (not per-tier branching)', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'cli', 'commands', 'stacks-new.ts'),
      'utf8',
    );

    // Strip block comments, import lines, and line comments before matching so a
    // mention of `buildScaffold(` in a comment or import can't inflate the call
    // count — we want to count real call sites in executable code only.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('import'))
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    const calls = code.match(/buildScaffold\s*\(/g) ?? [];
    expect(calls.length).toBe(1);

    expect(code).toMatch(/buildScaffold\(\s*name\s*,\s*tier\s*\)/);

    expect(code).toContain('const tier = readTier(parsed);');
    expect(code).not.toMatch(/buildScaffold\([^)]*['"]project['"]/);
    expect(code).not.toMatch(/buildScaffold\([^)]*['"]user['"]/);
  });

  it('scaffold.ts exposes exactly one exported scaffold builder taking a single tier arg', () => {
    const src = readFileSync(
      path.join(repoRoot, 'src', 'cli', 'lib', 'scaffold.ts'),
      'utf8',
    );
    const exportedBuilders = src.match(/export function buildScaffold\b/g) ?? [];
    expect(exportedBuilders.length).toBe(1);
    expect(src).toMatch(
      /export function buildScaffold\(\s*name:\s*string,\s*tier:\s*ScaffoldTier\s*=\s*'project'\s*\)/,
    );
  });
});
