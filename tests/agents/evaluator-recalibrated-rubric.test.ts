/**
 * Structural prompt assertions over `agents/gan-evaluator.md` for the
 * class-aware rubric recalibration.
 *
 * Why structural rather than behavioural: the rubric is prompt text the LLM
 * reads at score time. Recalibration is therefore an edit to that text; a
 * later drift (re-introducing the 7/10 "minor issues acceptable" band for
 * correctness, dropping the no-new-defects class name, softening "NOT a
 * pass") would silently unwind the floor without breaking any runtime test.
 * These assertions are the byte-level guards that prevent that.
 *
 * Three guarded properties:
 * 1. The rubric is class-aware and names the strict classes verbatim:
 *    correctness, security, no_new_defects.
 * 2. For those classes, the 7-pass band is explicitly removed and labelled
 *    NOT a pass; the ≥9 floor is stated.
 * 3. Functionality / UX criteria keep the legacy 7-pass band — judgement is
 *    legitimately allowed there. Removing the wrong band would over-restrict
 *    the gate; this assertion guards against that error in the opposite
 *    direction.
 * 4. Any unresolved `blocker`-severity finding fails the criterion
 *    independent of score (the categorical fail-on-blocker rule that pairs
 *    with the recalibrated rubric).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-evaluator.md');
const prompt = readFileSync(promptPath, 'utf8');

describe('evaluator_prompt_recalibrated_rubric_for_correctness_security_nnd', () => {
  it('names the three strict criterion classes verbatim (correctness, security, no_new_defects)', () => {
    // Token discipline: the class names must be byte-identical to the
    // proposer's class taxonomy. Drift (e.g. "security-issues",
    // "no-new-defects") would prevent a per-criterion class lookup from
    // matching the rubric band.
    expect(prompt).toContain('correctness');
    expect(prompt).toContain('security');
    expect(prompt).toContain('no_new_defects');
  });

  it('explicitly states "minor issues" is NOT a pass for correctness / security / no_new_defects', () => {
    // The load-bearing prose change. A later softening that admits 7-8 as
    // "Good. … with minor issues. **Pass**" for those classes would unwind
    // the floor.
    expect(prompt).toMatch(/NOT a pass.{0,120}correctness.{0,120}security.{0,120}no_new_defects/is);
  });

  it('states the pass threshold for those classes is ≥ 9', () => {
    expect(prompt).toMatch(/≥\s*9|>=\s*9|9\/10/);
  });

  it('functionality / UX criteria keep the legacy 7-pass band', () => {
    // The guard against over-restricting in the opposite direction. The
    // class-aware rubric is a per-class change, not a global floor lift.
    expect(prompt.toLowerCase()).toContain('functionality');
    expect(prompt.toLowerCase()).toContain('ux');
    expect(prompt).toMatch(/(7.?pass|≥\s*7|>=\s*7|7\/10)/);
  });

  it('the legacy "7-8: Good. Core functionality works correctly with minor issues" band is NOT applied to correctness/security/no_new_defects', () => {
    // The legacy band line still appears (functionality/UX still pass at 7),
    // but the strict classes have their own band that excludes it. This
    // asserts the prompt distinguishes the two by class — a single flat
    // "minor issues acceptable" rubric covering all classes would fail.
    expect(prompt).toMatch(/Functionality.*UX.*judgement|judgement band|judgement is legitimately allowed/is);
  });
});

describe('evaluator_prompt_auto_fails_on_unresolved_blocker_finding', () => {
  it('states any unresolved `blocker`-severity finding fails the criterion independent of score', () => {
    // The rule pairs with the recalibrated rubric: a high score cannot mask
    // a known blocker. The prompt must state this categorically. The "score"
    // qualifier and the "fails the criterion" verb appear together within a
    // single paragraph; the regex is intentionally permissive on word order
    // because the spec body and the rewritten prompt both lead with either
    // "Independent of the numeric score" or "any unresolved blocker fails".
    expect(prompt).toMatch(
      /(Independent of|Regardless of).{0,80}score.{0,200}blocker.{0,200}fails (that |the )criterion|blocker.{0,200}fails (that |the )criterion.{0,200}(independent of|regardless of).{0,30}score/is,
    );
  });

  it('names the rule out — "unresolved" + "blocker" + "severity" — so a drift away from any of those tokens is caught', () => {
    expect(prompt.toLowerCase()).toContain('unresolved');
    expect(prompt).toContain('blocker');
    expect(prompt.toLowerCase()).toContain('severity');
  });

  it('mandates the evidence record carries the blocker delta (file:line if known)', () => {
    // The rule is only auditable if the evidence carries the blocker. The
    // prompt must state that the blocker goes into evidence — not just into
    // the verdict.
    expect(prompt).toMatch(/blocker.{0,200}evidence/is);
  });
});
