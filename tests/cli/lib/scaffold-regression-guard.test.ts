/**
 * R6 sprint 3 — closing regression guard for the tier-aware scaffold.
 *
 * This is test-only. It adds no production behaviour beyond R6 sprints
 * 1 + 2; it pins the R6 contract so later work cannot silently regress
 * it. Three guards:
 *
 *  1. The UN-EDITED scaffold (as emitted by `buildScaffold`, for both
 *     tiers) STILL fails validation, and the failure set is attributable
 *     to the DRAFT banner + the command/scope/secrets TODO stubs (the
 *     intentional "finish me" friction) — and explicitly does NOT include
 *     a `detection.tier3_only` `InvariantViolation` and does NOT include a
 *     C1 detection parse rejection (`SchemaMismatch` on `/detection`).
 *     The point: R6 NARROWED the failure set, it did not make the raw
 *     scaffold spuriously valid.
 *
 *  2. The FULLY-EDITED scaffold (every TODO stub replaced with a
 *     schema-valid value, DRAFT banner + second-line CI warning removed)
 *     passes with ZERO residual structural invariants, for BOTH `project`
 *     and `user` tiers — with explicit, named assertions that no
 *     `detection.tier3_only` `InvariantViolation` and no C1 `/detection`
 *     parse rejection are present.
 *
 *  3. tier→body selection remains centralised in `buildScaffold` (one
 *     function, one tier argument) and was not scattered across call
 *     sites (`stacks-new.ts` calls `buildScaffold` exactly once with the
 *     resolved tier; the two tiers differ only in the activation-comment
 *     overlay phrase).
 *
 * Spec: specifications/R6-tier-aware-stack-scaffold.md (Bite-size note,
 * slice 3 — "the closing guard").
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildScaffold, DRAFT_BANNER } from '../../../src/cli/lib/scaffold.js';
import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';
import {
  validateStackBodyAgainstSchema,
  type Issue,
} from '../../../src/config-server/validation/schema-check.js';
import { checkDetectionTier3Only } from '../../../src/config-server/invariants/detection-tier3-only.js';
import type { ValidationSnapshot } from '../../../src/config-server/tools/validate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

const TIERS = ['project', 'user'] as const;
type Tier = (typeof TIERS)[number];

const SECOND_LINE =
  "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

/** Parse the YAML frontmatter of a scaffold (parseYamlBlock tolerates the
 * leading DRAFT banner / comment prose). */
function frontmatter(text: string): Record<string, unknown> {
  const parsed = parseYamlBlock(text);
  return (parsed.data ?? {}) as Record<string, unknown>;
}

/**
 * Run the full structural validation surface against a parsed stack body
 * at a given tier: C1 schema (`validateStackBodyAgainstSchema`, which
 * includes the schema's `/detection` parse rejection) PLUS the
 * `detection.tier3_only` cross-file invariant. Returns the combined,
 * structured issue list — callers assert on `code`/`field`, not just a
 * count.
 */
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

/** True if the issue set contains a `detection.tier3_only`
 * `InvariantViolation` (the pre-R6 trap on the `/detection` field). */
function hasDetectionTier3Invariant(issues: Issue[]): boolean {
  return issues.some(
    (i) => i.code === 'InvariantViolation' && (i.field ?? '') === '/detection',
  );
}

/** True if the issue set contains a C1 parse-time rejection of a
 * `detection` block (a `SchemaMismatch` raised against `/detection` —
 * C1's schema rejecting project/user-tier detection at parse time). */
function hasC1DetectionParseRejection(issues: Issue[]): boolean {
  return issues.some(
    (i) =>
      i.code === 'SchemaMismatch' &&
      (i.field ?? '').startsWith('/detection'),
  );
}

/**
 * Programmatically perform the documented first-edit pass on a freshly
 * built scaffold:
 *
 *  - replace EVERY TODO-marked stub (scope, buildCmd, testCmd, lintCmd,
 *    auditCmd, secretsGlob, securitySurfaces) with a schema-valid value;
 *  - the DRAFT banner + second-line CI warning are dropped implicitly
 *    (we validate the parsed frontmatter body, and additionally assert
 *    below that a textual banner+second-line strip yields a banner-free
 *    document).
 *
 * The transformation is mechanical — driven by the documented edit pass,
 * not a hand-authored valid file.
 */
function editedBody(name: string, tier: Tier): Record<string, unknown> {
  const body = frontmatter(buildScaffold(name, tier));
  return {
    ...body,
    scope: ['src/**/*'],
    buildCmd: 'echo build',
    testCmd: 'echo test',
    lintCmd: 'echo lint',
    auditCmd: { command: 'echo audit', absenceSignal: 'silent' },
    secretsGlob: ['**/*.pem'],
    securitySurfaces: [],
  };
}

/** Textually strip the DRAFT banner block (banner line + the second-line
 * CI warning that belongs to the banner block) from a scaffold, the way
 * the documented first-edit pass tells the author to. */
function stripBannerBlock(text: string): string {
  return text
    .split('\n')
    .filter((l) => l !== DRAFT_BANNER && l !== SECOND_LINE)
    .join('\n');
}

describe('R6 closing guard — un-edited scaffold still fails (narrowed, not removed)', () => {
  for (const tier of TIERS) {
    it(`un-edited ${tier}-tier scaffold STILL fails validation`, () => {
      const out = buildScaffold('acme-svc', tier);
      const issues = structuralIssues('acme-svc', tier, frontmatter(out));
      // Non-empty issue set: R6 did NOT make the raw scaffold valid.
      expect(issues.length).toBeGreaterThan(0);
    });

    it(`un-edited ${tier}-tier failure is attributable to the TODO stubs`, () => {
      const out = buildScaffold('acme-svc', tier);
      const issues = structuralIssues('acme-svc', tier, frontmatter(out));
      // The TODO stubs produce schema-violating shapes (e.g. auditCmd is
      // a string, securitySurfaces empty-but-stubbed, scope a TODO glob).
      const schemaIssues = issues.filter((i) => i.code === 'SchemaMismatch');
      expect(schemaIssues.length).toBeGreaterThan(0);
      // The DRAFT banner + second-line CI warning are present in the raw
      // text (the banner-invariant friction the scaffold deliberately
      // keeps; full end-to-end banner firing is covered by the
      // stack.no_draft_banner invariant suite).
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
      // Positive, self-documenting assertion of the SPECIFIC pre-R6 trap.
      const issues = structuralIssues('acme-svc', tier, editedBody('acme-svc', tier));
      expect(hasDetectionTier3Invariant(issues)).toBe(false);
      expect(
        issues.some((i) => i.code === 'InvariantViolation'),
      ).toBe(false);
    });

    it(`fully-edited ${tier}-tier scaffold: parses cleanly under C1 (no /detection parse rejection)`, () => {
      const issues = structuralIssues('acme-svc', tier, editedBody('acme-svc', tier));
      expect(hasC1DetectionParseRejection(issues)).toBe(false);
      // Distinct from invariant-absence: the C1 schema itself raised no
      // SchemaMismatch at all for the edited body.
      expect(issues.some((i) => i.code === 'SchemaMismatch')).toBe(false);
    });

    it(`scaffold frontmatter has NO detection key (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      const fm = frontmatter(out);
      expect('detection' in fm).toBe(false);
      // Defence in depth: no bare `detection:` line anywhere in the body.
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
        .replace('your project overlay (.claude/gan/project.md)', 'OVERLAY')
        .replace('your user overlay (~/.claude/gan/user.md)', 'OVERLAY')
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
    // Strip line comments, block comments and the import line so we count
    // real invocations, not the symbol import or doc-comment mentions.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('import'))
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    const calls = code.match(/buildScaffold\s*\(/g) ?? [];
    expect(calls.length).toBe(1);
    // The single call passes the resolved tier through (one function, one
    // tier argument), not a per-tier literal.
    expect(code).toMatch(/buildScaffold\(\s*name\s*,\s*tier\s*\)/);
    // The command resolves the tier once via readTier and never branches
    // on the tier value to assemble scaffold body content.
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
