/**
 * R3 sprint 4 — unit tests for `lib/scaffold.ts`.
 *
 * Covers contract criteria AC4 + AC5 + identity check that the scaffold's
 * re-exported `DRAFT_BANNER` is the same `===` binding as the canonical
 * constant in `src/config-server/scaffold-banner.ts`.
 */
import { describe, expect, it } from 'vitest';

import { buildScaffold, DRAFT_BANNER as SCAFFOLD_BANNER } from '../../../src/cli/lib/scaffold.js';
import { DRAFT_BANNER as SOURCE_BANNER } from '../../../src/config-server/scaffold-banner.js';
import {
  validateStackBodyAgainstSchema,
  type Issue,
} from '../../../src/config-server/validation/schema-check.js';
import { checkDetectionTier3Only } from '../../../src/config-server/invariants/detection-tier3-only.js';
import type { ValidationSnapshot } from '../../../src/config-server/tools/validate.js';
import {
  SCAFFOLD_SECOND_LINE as EXPECTED_SECOND_LINE,
  scaffoldFrontmatter as frontmatter,
  editedScaffoldBody as editedBody,
} from '../helpers/scaffold-edit.js';

// R6: `detection` is intentionally NO LONGER a scaffold key at
// project/user tier (C5 / F3 detection.tier3_only). Every other stubbed
// field is unchanged.
const REQUIRED_KEYS = [
  'scope',
  'secretsGlob',
  'auditCmd',
  'buildCmd',
  'testCmd',
  'lintCmd',
  'securitySurfaces',
];

const TIERS = ['project', 'user'] as const;

function nonBlankLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length > 0);
}

function validateEdited(name: string, tier: (typeof TIERS)[number]): Issue[] {
  const data = editedBody(name, tier);
  const issues: Issue[] = [];
  validateStackBodyAgainstSchema(`/virtual/${name}.md`, data, issues);
  const snapshot = {
    stackFiles: new Map([[`${tier}:/virtual/${name}.md`, { tier, path: `/virtual/${name}.md`, data }]]),
  } as unknown as ValidationSnapshot;
  issues.push(...checkDetectionTier3Only(snapshot));
  return issues;
}

describe('buildScaffold — banner identity', () => {
  it('re-exports DRAFT_BANNER as the same binding (=== identity)', () => {
    expect(SCAFFOLD_BANNER).toBe(SOURCE_BANNER);
  });

  it('exposes the canonical banner literal verbatim', () => {
    expect(SOURCE_BANNER).toBe('# DRAFT — replace TODOs and remove this banner before committing.');
  });
});

describe('buildScaffold — output shape', () => {
  it('first non-blank line is the canonical DRAFT_BANNER', () => {
    const out = buildScaffold('web-node');
    const lines = nonBlankLines(out);
    expect(lines[0]).toBe(SOURCE_BANNER);
  });

  it('second non-blank line is the explanatory comment', () => {
    const out = buildScaffold('web-node');
    const lines = nonBlankLines(out);
    expect(lines[1]).toBe(EXPECTED_SECOND_LINE);
  });

  it('contains a YAML frontmatter block delimited by `---` with schemaVersion: 1', () => {
    const out = buildScaffold('web-node');
    // The frontmatter block opens and closes with a `---` line. The
    // canonical R1 parser (`parseYamlBlock`) only accepts this form.
    expect(out).toMatch(/^[\s\S]*?\n---\n[\s\S]*?\n---\n/);
    expect(out).toContain('schemaVersion: 1');
  });

  it('YAML body declares name: <name>', () => {
    const a = buildScaffold('web-node');
    const b = buildScaffold('ios-swift');
    expect(a).toContain('name: web-node');
    expect(b).toContain('name: ios-swift');
  });

  it('contains every required key (detection, scope, secretsGlob, audit/build/test/lint, securitySurfaces)', () => {
    const out = buildScaffold('web-node');
    for (const key of REQUIRED_KEYS) {
      expect(out, `missing key '${key}' in scaffold output`).toContain(key);
    }
  });

  it('contains the audit-stub substring with double-space-after-false', () => {
    const out = buildScaffold('web-node');
    expect(out).toContain('"false  # TODO: replace before committing');
  });

  it('contains a trailing prose section starting with `## Conventions`', () => {
    const out = buildScaffold('web-node');
    expect(out).toContain('## Conventions');
    // The conventions section must come after the closing `---` marker.
    const closingMarker = out.lastIndexOf('\n---\n');
    const conventions = out.indexOf('## Conventions');
    expect(closingMarker).toBeGreaterThan(-1);
    expect(conventions).toBeGreaterThan(closingMarker);
  });

  it('ends with a single trailing newline', () => {
    const out = buildScaffold('web-node');
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n\n')).toBe(false);
    // The penultimate character should not be a newline (i.e. exactly one
    // trailing newline, not two).
    const len = out.length;
    expect(len).toBeGreaterThan(1);
    expect(out[len - 2]).not.toBe('\n');
  });

  it('is deterministic: same name yields byte-identical output', () => {
    const a = buildScaffold('web-node');
    const b = buildScaffold('web-node');
    expect(a).toBe(b);
  });
});

describe('buildScaffold — R6 tier-aware, detection-free body', () => {
  it('signature accepts both `project` and `user` tiers', () => {
    expect(typeof buildScaffold('acme-svc', 'project')).toBe('string');
    expect(typeof buildScaffold('acme-svc', 'user')).toBe('string');
    // Default (no tier arg) keeps the legacy call site compiling.
    expect(typeof buildScaffold('acme-svc')).toBe('string');
  });

  for (const tier of TIERS) {
    it(`emits no \`detection:\` key in YAML frontmatter (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      const fm = frontmatter(out);
      expect('detection' in fm).toBe(false);
      // Defence in depth: no bare `detection:` line anywhere in the body.
      expect(out).not.toMatch(/^\s*detection\s*:/m);
    });

    it(`activation comment names stack.override + both activation paths (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      expect(out).toContain('stack.override');
      // Same-name shadow path.
      expect(out).toMatch(/same `name:` shadows\/replaces it/);
      // Forced-activation path.
      expect(out).toContain('being forced via `stack.override`');
      // Without one of the two it never activates.
      expect(out).toContain('this');
      expect(out).toMatch(/Without one of those, this\s+# stack never becomes active/);
    });

    it(`activation comment states override is wholesale/replacement (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      expect(out).toContain('`stack.override` REPLACES auto-detection');
      expect(out).toContain('it is not additive');
      expect(out).toContain('every detected stack and the `generic` fallback');
      expect(out).toMatch(/list `generic` and any/);
    });

    it(`activation comment sources the decision to C5 / F3 detection.tier3_only (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      expect(out).toContain('C5 / F3 detection.tier3_only');
    });

    it(`scope: stays a TODO stub (not removed alongside detection) (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      expect(out).toMatch(/scope:\n\s*- "TODO\/\*\*\/\*"/);
    });

    it(`is pure & deterministic: same (name, '${tier}') is byte-identical`, () => {
      const a = buildScaffold('acme-svc', tier);
      const b = buildScaffold('acme-svc', tier);
      expect(a).toBe(b);
    });

    it(`edited scaffold (TODOs replaced, banner removed) validates with zero errors (${tier} tier)`, () => {
      const issues = validateEdited('acme-svc', tier);
      expect(
        issues,
        `expected zero validation issues, got: ${JSON.stringify(issues, null, 2)}`,
      ).toEqual([]);
      expect(issues.some((i) => i.code === 'InvariantViolation')).toBe(false);
    });

    it(`intentional friction preserved: DRAFT banner + CI warning + TODO stubs (${tier} tier)`, () => {
      const out = buildScaffold('acme-svc', tier);
      const lines = nonBlankLines(out);
      expect(lines[0]).toBe(SOURCE_BANNER);
      expect(lines[1]).toBe(EXPECTED_SECOND_LINE);
      expect(out).toContain('"TODO/**/*"');
      expect(out).toContain('false  # TODO: replace before committing');
      // The un-edited scaffold must still fail schema validation (TODO
      // stubs produce schema-violating shapes) — R6 narrows the failure
      // set, it does not make the raw scaffold spuriously valid.
      const issues: Issue[] = [];
      validateStackBodyAgainstSchema(
        `/virtual/acme-svc.md`,
        frontmatter(out),
        issues,
      );
      expect(issues.length).toBeGreaterThan(0);
    });
  }

  it('project and user tiers emit the same body except the overlay named in the override hint', () => {
    const proj = buildScaffold('acme-svc', 'project');
    const user = buildScaffold('acme-svc', 'user');
    expect(proj).not.toBe(user);
    expect(proj).toContain('project overlay (.claude/gan/project.md)');
    expect(user).toContain('user overlay (~/.claude/gan/user.md)');
    // The activation comment now byte-matches the spec Examples block: the
    // line ends "...`stack.override` in your" and the overlay name begins
    // the next line. Everything outside the overlay-hint + tier-word lines
    // is identical between tiers.
    const normalise = (s: string): string =>
      s
        .replace('project overlay (.claude/gan/project.md)', 'OVERLAY')
        .replace('user overlay (~/.claude/gan/user.md)', 'OVERLAY')
        .replace('# This stack is project-tier:', '# This stack is TIER:')
        .replace('# This stack is user-tier:', '# This stack is TIER:');
    expect(normalise(proj)).toBe(normalise(user));
  });
});
