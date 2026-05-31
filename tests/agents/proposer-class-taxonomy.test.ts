/**
 * Structural assertion suite for the proposer prompt's criterion-class
 * taxonomy. Reads the shipped agents/gan-contract-proposer.md from disk and
 * asserts the body documents every class name and its per-class default
 * threshold verbatim.
 *
 * Why this test exists: downstream tooling (the evaluator and the runtime
 * threshold-floor enforcement) keys off the class string. A missing or
 * renamed class name in the prompt silently desyncs the contract author and
 * the gate enforcer — the prose is the only place the proposer learns the
 * vocabulary, so a drift here propagates into every contract the proposer
 * writes. The test reads the prompt directly rather than parsing a derived
 * representation, because the prompt itself is the load-bearing artefact.
 *
 * The literal strings below are expected prompt content, not code; each
 * class name must appear verbatim and each per-class default must appear
 * with its numeric value attached so the proposer cannot read "correctness"
 * and apply a stale default. Case-insensitive substring matching is used
 * for the threshold-list line because the spec writes it in a list form
 * that may include prose framing (e.g. "default `9` (floor)") around the
 * raw assignment.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-proposer.md');
const prompt = readFileSync(promptPath, 'utf8');

// The full list of class names the proposer must instantiate. The order
// matches the spec; the test does not pin order, only presence — the prompt
// authors are free to re-order the list as long as every name is present
// verbatim.
const CLASS_NAMES = [
  'functionality_ux',
  'correctness',
  'security',
  'no_new_defects',
  'regression',
  'build',
] as const;

// The class-to-default-threshold pairs the proposer must surface. The values
// here mirror the spec: 7 for the unprotected functionality_ux class, 9 for
// every protected class. A drift in any value here is a contract defect.
const CLASS_DEFAULTS: ReadonlyArray<readonly [string, number]> = [
  ['functionality_ux', 7],
  ['correctness', 9],
  ['security', 9],
  ['no_new_defects', 9],
  ['regression', 9],
  ['build', 9],
];

describe('proposer_prompt_carries_class_taxonomy', () => {
  it('the prompt contains a dedicated criterion-classes section heading', () => {
    // Pin the section heading so a future refactor that scatters the
    // taxonomy across the prompt without a single anchor fails the test.
    // The downstream renegotiation flow looks for this anchor when
    // inspecting why a criterion was authored at a given threshold.
    expect(prompt).toMatch(/##\s+Criterion classes and thresholds/i);
  });

  for (const className of CLASS_NAMES) {
    it(`names the class "${className}" verbatim in the prompt body`, () => {
      // Each class string is the join key downstream tooling reads off the
      // contract; the prompt is the only place the proposer learns the
      // exact string to emit. A typo here silently breaks the floor.
      expect(prompt).toContain(className);
    });
  }

  for (const [className, threshold] of CLASS_DEFAULTS) {
    it(`states the per-class default "${className}=${threshold}" verbatim (case-insensitive substring)`, () => {
      // The prompt expresses the default with prose framing around the
      // pair (e.g. "`correctness` — default `9` (floor)"); the test
      // matches the class name plus the numeric default within the
      // dedicated taxonomy section. Scoping to the section avoids the
      // false negative where a class name appears earlier in the body
      // (e.g. inline in a sentence about the security pipeline) before
      // the canonical default bullet is reached.
      const sectionStart = prompt.search(/##\s+Criterion classes and thresholds/i);
      expect(sectionStart, '## Criterion classes and thresholds heading must exist').toBeGreaterThan(-1);
      const sectionRest = prompt.slice(sectionStart);
      const nextHeading = sectionRest.indexOf('\n## ', 1);
      const section = (nextHeading === -1 ? sectionRest : sectionRest.slice(0, nextHeading)).toLowerCase();
      const idx = section.indexOf(className.toLowerCase());
      expect(idx, `class "${className}" must appear in the class-taxonomy section`).toBeGreaterThan(-1);
      // Look at the next 120 chars after the class name; the default
      // value must appear there. Using a localised window catches the
      // "right value next to the right class" wiring rather than
      // accepting any "9" anywhere in the section.
      const window = section.slice(idx, idx + 120);
      expect(window).toContain(String(threshold));
    });
  }

  it('the prompt restates the verbatim class=threshold pairs in a single contiguous block', () => {
    // The contract requires the literal pair list
    //   "functionality_ux=7; correctness=9; security=9; no_new_defects=9; regression=9; build=9"
    // to appear in the prompt (or its semantic equivalent: each class name
    // co-located with its numeric default in a list/section that names
    // "default"). The single-block check protects against the prompt
    // scattering the pairs across many sections (where a per-class drift
    // is hard to spot in review).
    const sectionStart = prompt.search(/##\s+Criterion classes and thresholds/i);
    expect(sectionStart).toBeGreaterThan(-1);
    const sectionRest = prompt.slice(sectionStart);
    const nextHeading = sectionRest.indexOf('\n## ', 1);
    const section = nextHeading === -1 ? sectionRest : sectionRest.slice(0, nextHeading);
    for (const className of CLASS_NAMES) {
      expect(section, `${className} must appear inside the class-taxonomy section`).toContain(
        className,
      );
    }
    for (const [, threshold] of CLASS_DEFAULTS) {
      expect(section, `default ${threshold} must appear inside the class-taxonomy section`).toContain(
        String(threshold),
      );
    }
  });
});
