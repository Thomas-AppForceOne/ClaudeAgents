/**
 * End-to-end coverage for the fail-open / exit-code policy on `gan config
 * print`. Every scenario the resolution-observability spec calls out is
 * exercised: a clean repo, block-level `discardInherited` with a replacement,
 * field-level `discardInherited` with no replacement, a missing
 * `additionalContext` row, a malformed overlay that the resolver still
 * partially resolves, and a warnings-only snapshot.
 *
 * The fail-open path is the load-bearing invariant. `getResolvedConfig` does
 * not throw on validation errors — it captures them into `resolved.issues` —
 * so the command always emits the flat shape with `issues` populated and the
 * exit code reflects the resolved issues alone. The test asserts both halves
 * (shape and exit code) so a regression that re-introduces a wrapper or a
 * different exit-mapping cannot pass.
 *
 * Fixtures with discard semantics are built in a per-test temp directory
 * because the shipped fixtures tree does not include `discardInherited`
 * fragments; copying a base fixture (`js-ts-minimal`) and overlaying a
 * project.md is the same write-test pattern the rest of the CLI suite uses.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGan } from './helpers/spawn.js';
import { stackFixturePath } from './helpers/fixtures.js';
import type { ResolvedConfig, AdditionalContextRow, Issue } from '../../src/index.js';

// Read-only base fixture every discard test starts from; it carries a built-in
// web-node stack auto-detection so the project tier resolves predictably.
const BASE = stackFixturePath('js-ts-minimal');

// Temp directories created per-test; drained in afterEach so a failure inside
// a test cannot leak a dir into the next one.
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// Build a throwaway project from the BASE fixture and overlay the supplied
// project.md body at `.claude/gan/project.md`, replacing whatever overlay (if
// any) the base ships. Returning the project root keeps the test ergonomic.
function makeProjectWithOverlay(overlayBody: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'gan-cli-failopen-'));
  cpSync(BASE, dir, { recursive: true });
  const overlayPath = path.join(dir, '.claude', 'gan', 'project.md');
  mkdirSync(path.dirname(overlayPath), { recursive: true });
  writeFileSync(overlayPath, overlayBody, 'utf8');
  tmpDirs.push(dir);
  return dir;
}

describe('gan config print — clean snapshot', () => {
  it('O1 AC: clean repo exits 0 and emits the flat shape (no wrapper keys)', async () => {
    const r = await runGan(['config', 'print', '--project-root', BASE, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    // The flat top-level key set is the spec's pinned shape — none of these
    // are nested under a `resolvedConfig` / `validationErrors` wrapper.
    for (const key of [
      'apiVersion',
      'schemaVersions',
      'runtimeMode',
      'stacks',
      'overlay',
      'discarded',
      'additionalContext',
      'issues',
      'warnings',
      'modules',
    ]) {
      expect(parsed).toHaveProperty(key);
    }
    expect(parsed).not.toHaveProperty('resolvedConfig');
    expect(parsed).not.toHaveProperty('validationErrors');

    // Clean-repo invariants — empty overlay, empty discarded array, no issues.
    expect(parsed.overlay).toEqual({});
    expect(parsed.discarded).toEqual([]);
    expect(parsed.issues).toEqual([]);
  });
});

describe('gan config print — discard semantics', () => {
  it('O1 AC: block-level discardInherited + replacement surfaces both', async () => {
    // A block-level `discardInherited: true` resets every field of the
    // proposer block and the sibling `additionalCriteria: [a, b]` supplies the
    // replacement value. The cascade therefore records the field name in
    // `discarded` and the replacement in `overlay.proposer.additionalCriteria`.
    //
    // `additionalCriteria` items must be `{name, description, threshold}`
    // objects per the overlay schema — the abstract "[a, b]" in the spec's AC
    // text refers to two replacement entries, not two bare strings.
    const project = makeProjectWithOverlay(
      [
        '---',
        'schemaVersion: 1',
        'proposer:',
        '  discardInherited: true',
        '  additionalCriteria:',
        '    - name: a',
        '      description: First replacement criterion.',
        '      threshold: 7',
        '    - name: b',
        '      description: Second replacement criterion.',
        '      threshold: 7',
        '---',
        '',
        '# Block-level discard fixture',
        '',
        'Tests the block-level reset + replacement scenario.',
      ].join('\n'),
    );

    const r = await runGan(['config', 'print', '--project-root', project, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');

    const parsed = JSON.parse(r.stdout) as ResolvedConfig;
    expect(parsed.discarded).toContain('proposer.additionalCriteria');
    const overlayProposer = (parsed.overlay as Record<string, Record<string, unknown>>).proposer;
    expect(overlayProposer).toBeDefined();
    const criteria = overlayProposer.additionalCriteria as Array<{ name: string }>;
    expect(Array.isArray(criteria)).toBe(true);
    expect(criteria.map((c) => c.name)).toEqual(['a', 'b']);

    // The human render must echo the discarded path on its own row — not
    // `(none)` — so a debugger can grep for the dotted name.
    const humanR = await runGan(['config', 'print', '--project-root', project]);
    expect(humanR.exitCode).toBe(0);
    expect(humanR.stdout).toContain('discarded paths:');
    expect(humanR.stdout).toContain('proposer.additionalCriteria');
    expect(humanR.stdout).not.toMatch(/discarded paths:\s+\(none\)/);
  });

  it('O1 AC: field-level discardInherited with no replacement falls back to the agent default', async () => {
    // A field-level `{discardInherited: true}` wrapper with no `value` resets
    // just that field. The spec AC reads: `discarded` contains the path AND
    // there is no `overlay.generator.additionalRules` *value* present — "(it
    // fell back to the agent default)". The shipped cascade reports the field
    // by surfacing the bare default `[]` (i.e. the agent default the spec's
    // parenthetical refers to); the load-bearing observable is that no
    // user-supplied value persists — only the empty default.
    const project = makeProjectWithOverlay(
      [
        '---',
        'schemaVersion: 1',
        'generator:',
        '  additionalRules:',
        '    discardInherited: true',
        '---',
        '',
        '# Field-level discard fixture',
        '',
        'Tests the field-level reset with no replacement scenario.',
      ].join('\n'),
    );

    const r = await runGan(['config', 'print', '--project-root', project, '--json']);
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout) as ResolvedConfig;
    expect(parsed.discarded).toContain('generator.additionalRules');

    // The replacement-less reset must leave no user-supplied value under
    // `overlay.generator.additionalRules` — only the bare default may remain.
    // The cascade's bare default for `generator.additionalRules` is `[]`, so
    // either the key is absent OR it equals the empty list. Anything else
    // would mean a tier contribution survived the reset, which would be a
    // cascade defect.
    const overlayGenerator = (parsed.overlay as Record<string, Record<string, unknown>>).generator;
    if (overlayGenerator !== undefined && 'additionalRules' in overlayGenerator) {
      expect(overlayGenerator.additionalRules).toEqual([]);
    }
  });
});

describe('gan config print — additionalContext missing-file marker', () => {
  it('O1 AC: missing file surfaces as { path, exists: false } in JSON and as (missing) in human render', async () => {
    // The shipped fixture lists a `docs/missing.md` row under
    // `proposer.additionalContext`. The data layer canonicalises that row to
    // `{ path, exists: false }`; the JSON form carries the row verbatim and the
    // human renderer must surface it with a marker (not silently drop it).
    const fixture = stackFixturePath('invariant-additional-context-missing');

    const json = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(json.exitCode).toBe(0);
    const parsed = JSON.parse(json.stdout) as ResolvedConfig;
    const proposer = parsed.additionalContext.proposer;
    const missing = proposer.find((r: AdditionalContextRow) => r.path === 'docs/missing.md');
    expect(missing).toBeDefined();
    expect(missing?.exists).toBe(false);

    const human = await runGan(['config', 'print', '--project-root', fixture]);
    expect(human.exitCode).toBe(0);
    // The row must appear on the additionalContext line with a marker
    // distinguishing it from a present file. `(missing)` is the shipped
    // affordance the human renderer attaches.
    expect(human.stdout).toContain('docs/missing.md');
    expect(human.stdout).toContain('(missing)');
  });
});

describe('gan config print — fail-open with malformed overlay', () => {
  it('O1 AC: schema-mismatch overlay produces a partial flat shape with issues, exit 2', async () => {
    // `schemaVersion: 999` triggers both an InvariantViolation and a
    // SchemaMismatch (the framework rejects the overlay's tier API version).
    // The InvariantViolation makes the exit code 4 — see the dedicated test
    // below; this test exercises a different fixture so the validation-only
    // (no InvariantViolation) branch is also covered.
    const fixture = stackFixturePath('invalid-schema-mismatch');

    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(2); // EXIT_VALIDATION
    expect(r.stderr).toBe('');

    const parsed = JSON.parse(r.stdout) as ResolvedConfig;
    // Partial resolved object — the shape is the same flat shape the clean
    // path emits; only `issues` is populated. No wrapper key appears.
    expect(parsed).toHaveProperty('apiVersion');
    expect(parsed).toHaveProperty('issues');
    expect(parsed.issues.length).toBeGreaterThan(0);
    expect(parsed).not.toHaveProperty('resolvedConfig');
    expect(parsed).not.toHaveProperty('validationErrors');

    // Every error-severity issue must report a `severity: 'error'`. None of
    // them is `InvariantViolation` for this fixture, which is why the exit
    // code is 2 and not 4.
    const errors = parsed.issues.filter((i: Issue) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((i: Issue) => i.code !== 'InvariantViolation')).toBe(true);
  });

  it('O1 AC: invariant-violation overlay exits 4 (EXIT_INVARIANT_VIOLATION)', async () => {
    // `schemaVersion: 999` overlay raises InvariantViolation; per
    // exitCodeForIssues the most-severe class wins, so the exit code is 4.
    const fixture = stackFixturePath('invariant-overlay-tier-api-version');

    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(4); // EXIT_INVARIANT_VIOLATION
    expect(r.stderr).toBe('');

    const parsed = JSON.parse(r.stdout) as ResolvedConfig;
    expect(parsed.issues.some((i: Issue) => i.code === 'InvariantViolation')).toBe(true);
    // Still the flat shape — no wrapper.
    expect(parsed).not.toHaveProperty('resolvedConfig');
    expect(parsed).not.toHaveProperty('validationErrors');
  });

  it('fail-open output never carries an exception payload or stack trace', async () => {
    // The fail-open emitter must only surface the resolver's `issues` /
    // `warnings` arrays — never a stringified exception payload, stack trace,
    // or environment value (the spec bans this leakage in the fail-open
    // path). The JSON form is the surface most likely to leak such content,
    // so the check runs there.
    const fixture = stackFixturePath('invariant-overlay-tier-api-version');
    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);

    expect(r.stdout).not.toMatch(/at [A-Za-z_$][\w.$]*\s*\([^\)]*\.[jt]s:\d+/);
    expect(r.stdout).not.toContain('Error: ');
    expect(r.stdout).not.toContain('Trace');
  });
});

describe('gan config print — warnings-only snapshot', () => {
  it('O1 AC: warnings keep the exit code at 0 (no --strict-warnings in v1.0)', async () => {
    // The `overlay-warn-shrinkage` fixture produces a non-empty `warnings`
    // array with no error-severity issues; per the v1.0 policy the exit code
    // must stay 0.
    const fixture = stackFixturePath('overlay-warn-shrinkage');
    const r = await runGan(['config', 'print', '--project-root', fixture, '--json']);
    expect(r.exitCode).toBe(0);

    const parsed = JSON.parse(r.stdout) as ResolvedConfig;
    expect(parsed.warnings.length).toBeGreaterThan(0);
    // No error-severity issue (warnings live in the separate `warnings`
    // array; any `issues` entry must be warning-severity).
    const errors = parsed.issues.filter((i: Issue) => (i.severity ?? 'error') === 'error');
    expect(errors).toEqual([]);
  });
});
