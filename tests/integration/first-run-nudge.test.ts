/**
 * E1 invariant — first-run nudge (verbatim contract).
 *
 * E1 line 22 specifies the exact non-suppressible startup-log line the
 * orchestrator emits when the active stack set resolves to
 * `stacks/generic.md` only. The orchestrator itself is the `/gan`
 * skill's markdown prompt (`skills/gan/SKILL.md`), so the verbatim
 * string is exercised at runtime by Claude Code, not by a TypeScript
 * function call. This integration test stands as the regression
 * backstop for the contract:
 *
 *   1. The `tests/fixtures/stacks/generic-fallback/` fixture activates
 *      ONLY the `generic` stack — confirming the precondition the nudge
 *      hangs off.
 *   2. The verbatim nudge string from `specifications/E1-agent-integration.md`
 *      (line 22) appears unchanged inside `skills/gan/SKILL.md`. The
 *      string is loaded from disk at test runtime; the test itself
 *      never inlines the literal nudge text.
 *
 * Together these guarantee that an authoring drift in either the spec
 * or SKILL.md surfaces as a test failure. The fixture-side check
 * additionally guards detection from regressing.
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
// Literal spec path under `specifications/E1-agent-integration.md` — kept
// as a single string here so static auditing of this test sees the path
// as one token. The actual readFileSync uses `path.join` for portability.
const E1_SPEC_RELATIVE = 'specifications/E1-agent-integration.md';
const e1SpecPath = path.join(repoRoot, ...E1_SPEC_RELATIVE.split('/'));
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

beforeEach(() => clearResolvedConfigCache());
afterEach(() => clearResolvedConfigCache());

/**
 * Pull line 22 out of the E1 spec at test runtime (per the test
 * contract, the verbatim nudge string must NOT be hardcoded in this
 * file). The line carries the back-tick-enclosed nudge text; we
 * extract a stable substring ("No recognised ecosystem stack ..." up
 * to "as a starting point.") that is unique enough to act as a
 * regression check without dragging escape-handling complexity into
 * the test. Any drift in the spec's nudge wording — capitalisation,
 * punctuation, the "gan stacks new" CLI hint — surfaces here.
 */
function extractNudgeFromSpec(): string {
  const e1 = readFileSync(e1SpecPath, 'utf8');
  const lines = e1.split('\n');
  const line22 = lines[21]; // 1-indexed line 22
  // The nudge text begins with "No recognised" and ends with the
  // sentence "as a starting point."
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
    // Half 1 — fixture-side detection contract: the generic-fallback
    // project (no package.json, no other ecosystem signal) resolves to
    // exactly ["generic"], with built-in tier provenance.
    const resolved = await composeResolvedConfig(fixturePath, { packageRoot: repoRoot });
    expect(resolved.stacks.active).toEqual(['generic']);
    expect(Object.keys(resolved.stacks.byName)).toEqual(['generic']);
    const generic = resolved.stacks.byName.generic;
    expect(generic).toBeDefined();
    if (generic !== undefined) {
      expect(generic.tier).toBe('builtin');
    }

    // Half 2 — verbatim nudge contract: the nudge text loaded from
    // E1 line 22 at test runtime appears unchanged inside SKILL.md.
    const nudgeFromSpec = extractNudgeFromSpec();
    expect(nudgeFromSpec.length).toBeGreaterThan(20);
    // The CLI hint is part of the spec's contract; surface it loudly
    // if it disappears from E1's nudge text.
    expect(nudgeFromSpec).toMatch(/generic defaults/);
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toContain(nudgeFromSpec);
  });
});
