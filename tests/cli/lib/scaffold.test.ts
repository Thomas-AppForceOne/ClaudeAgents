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

const EXPECTED_SECOND_LINE =
  "# `gan validate` and CI's lint-stacks will fail while this banner is present.";

const REQUIRED_KEYS = [
  'detection',
  'scope',
  'secretsGlob',
  'auditCmd',
  'buildCmd',
  'testCmd',
  'lintCmd',
  'securitySurfaces',
];

function nonBlankLines(text: string): string[] {
  return text.split('\n').filter((l) => l.trim().length > 0);
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
