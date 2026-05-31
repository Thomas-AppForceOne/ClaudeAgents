/**
 * Structural assertion suite for the proposer prompt's threshold-floor
 * rule. Reads the shipped agents/gan-contract-proposer.md from disk and
 * asserts the body explicitly states that runner.thresholdOverride may
 * raise — but never lower — a correctness, security, or no_new_defects
 * criterion below 9.
 *
 * Why this test exists: an earlier rule ("never lower below the resolved
 * default") allowed an overlay-supplied thresholdOverride of 7 to drag a
 * security-class criterion down to the same threshold as a UX
 * functionality criterion. The protected-class floor closes that
 * loophole. The prompt is the single source the proposer reads when
 * choosing a per-criterion threshold, so the rule must be spelled out in
 * the prompt — and stay there as the prompt evolves.
 *
 * The literal strings are expected prompt content; case-insensitive
 * matching is used where the prompt may add prose framing (e.g.
 * "**may raise** but **never lowers**" with markdown emphasis).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-proposer.md');
const prompt = readFileSync(promptPath, 'utf8');

describe('proposer_prompt_states_threshold_floor', () => {
  it('names runner.thresholdOverride explicitly', () => {
    // The override knob's exact name is the runtime contract — the prompt
    // must use the same string the snapshot exposes so the proposer can
    // dereference it correctly.
    expect(prompt).toContain('runner.thresholdOverride');
  });

  it('states the override may raise but never lower the protected-class floor', () => {
    // Pin the raise/never-lower polarity in one assertion: the Thresholds
    // section must contain both "raise" and "never" (case-insensitive)
    // within a window small enough to bind them to the same rule. The
    // 200-character window keeps the match local to one sentence/paragraph.
    // Scoping to the Thresholds section avoids the false negative where
    // "raise" appears earlier in the prompt in unrelated prose
    // (e.g. an objection-payload bullet's "raised an objection").
    const sectionStart = prompt.search(/##\s+Thresholds/i);
    expect(sectionStart, '## Thresholds heading must exist').toBeGreaterThan(-1);
    const rest = prompt.slice(sectionStart);
    const nextHeading = rest.indexOf('\n## ', 1);
    const section = (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).toLowerCase();
    const raiseIdx = section.indexOf('raise');
    expect(raiseIdx, 'Thresholds section must say the override may raise the threshold').toBeGreaterThan(-1);
    const window = section.slice(raiseIdx, raiseIdx + 200);
    expect(window).toContain('never');
    expect(window).toContain('lower');
  });

  it('names the three protected classes alongside the floor rule', () => {
    // The three classes whose floor is the spec's load-bearing protection.
    // Each must appear within the threshold-floor language, not merely
    // somewhere in the file. The Thresholds section is the natural anchor;
    // the test locates that heading and scopes the protected-class check
    // to its content so a stray mention of "security" in an unrelated
    // section is not enough.
    const sectionStart = prompt.search(/##\s+Thresholds/i);
    expect(sectionStart, '## Thresholds heading must exist').toBeGreaterThan(-1);
    const rest = prompt.slice(sectionStart);
    const nextHeading = rest.indexOf('\n## ', 1);
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    for (const className of ['correctness', 'security', 'no_new_defects']) {
      expect(section, `protected class ${className} must appear in the Thresholds section`).toContain(
        className,
      );
    }
    // The numeric floor must be in the same section.
    expect(section).toContain('9');
  });

  it('states the lowering-7 case explicitly: a thresholdOverride of 7 lowers only the functionality_ux class', () => {
    // The spec calls out this exact user mistake: "a user's
    // thresholdOverride: 7 therefore lowers only the 7-default
    // (functionality_ux) classes". The phrasing protects against the
    // common misreading "thresholdOverride lowers everything to 7" — the
    // prompt must state the asymmetry. Look for "7" together with
    // "functionality_ux" within a paragraph-sized window.
    const lower = prompt.toLowerCase();
    const uxIdx = lower.indexOf('functionality_ux');
    expect(uxIdx).toBeGreaterThan(-1);
    // Scan around every functionality_ux mention; the test passes when at
    // least one occurrence is co-located with both "7" and "lower"
    // language inside a paragraph. The 300-character window covers a
    // wrapping paragraph without overshooting into the next bullet.
    let foundCoLocated = false;
    let cursor = uxIdx;
    while (cursor !== -1) {
      const window = lower.slice(cursor, cursor + 300);
      if (window.includes('7') && (window.includes('lower') || window.includes('only'))) {
        foundCoLocated = true;
        break;
      }
      cursor = lower.indexOf('functionality_ux', cursor + 1);
    }
    expect(
      foundCoLocated,
      'prompt must co-locate functionality_ux with the "lowers only" / 7-default language',
    ).toBe(true);
  });
});
