/**
 * End-to-end contract test for the first-run nudge defined by E1 spec line 22.
 *
 * The nudge is the line the startup log must emit when no real ecosystem stack
 * matches and resolution falls back to `stacks/generic.md` only. Its exact
 * wording is authored once, in the E1 spec, and the shipped `skills/gan/
 * SKILL.md` must carry that same string verbatim. This suite guards two halves
 * of that contract end-to-end:
 *  1. the generic-fallback fixture really does resolve to generic-only, and
 *  2. SKILL.md contains the nudge string lifted straight from the spec.
 *
 * Regression guarded: the spec wording and the SKILL.md copy drifting apart —
 * if either side is reworded without the other, this fails rather than letting
 * a stale nudge ship.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeResolvedConfig } from '../../src/config-server/resolution/resolved-config.js';
import { clearResolvedConfigCache } from '../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixturePath = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'generic-fallback');

const E1_SPEC_RELATIVE = 'specifications/E1-agent-integration.md';
const e1SpecPath = path.join(repoRoot, ...E1_SPEC_RELATIVE.split('/'));
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

// Resolution caches by project root; clear on each side of every test so a
// fixture is always composed fresh rather than served from a stale entry.
beforeEach(() => clearResolvedConfigCache());
afterEach(() => clearResolvedConfigCache());

// Read the nudge straight from the E1 spec so the test asserts against the
// authoritative wording, never a hand-copied duplicate that could drift.
function extractNudgeFromSpec(): string {
  const e1 = readFileSync(e1SpecPath, 'utf8');
  const lines = e1.split('\n');
  // Line 22 of the spec (zero-indexed 21) is where the nudge contract lives.
  const line22 = lines[21];

  // Slice the nudge out by its stable head/tail phrases rather than a brittle
  // column range; the markers bracket the exact substring SKILL.md must echo.
  const startMarker = 'No recognised';
  const endMarker = 'as a starting point.';
  const start = line22.indexOf(startMarker);
  const end = line22.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error(
      `extractNudgeFromSpec: could not locate the nudge markers in E1 line 22. ` +
        `Either the spec moved the line or the nudge wording changed; update this test.`,
    );
  }
  return line22.slice(start, end + endMarker.length);
}

describe('first-run nudge — E1 line 22 contract end-to-end', () => {
  it('generic-fallback fixture activates ONLY generic AND SKILL.md carries the verbatim E1 line 22 nudge string', async () => {

    // Half one: the fixture must resolve to the generic stack ONLY, and that
    // stack must come from the builtin tier — i.e. a genuine fallback, not a
    // project-supplied stack named "generic".
    const resolved = await composeResolvedConfig(fixturePath, { packageRoot: repoRoot });
    expect(resolved.stacks.active).toEqual(['generic']);
    expect(Object.keys(resolved.stacks.byName)).toEqual(['generic']);
    const generic = resolved.stacks.byName.generic;
    expect(generic).toBeDefined();
    if (generic !== undefined) {
      expect(generic.tier).toBe('builtin');
    }

    // Half two: pull the nudge from the spec and confirm SKILL.md carries it
    // verbatim. The length/content guards catch a spec edit that accidentally
    // emptied or gutted the markers before the contains-check runs.
    const nudgeFromSpec = extractNudgeFromSpec();
    expect(nudgeFromSpec.length).toBeGreaterThan(20);

    expect(nudgeFromSpec).toMatch(/generic defaults/);
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toContain(nudgeFromSpec);
  });
});
