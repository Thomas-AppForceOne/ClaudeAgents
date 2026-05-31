/**
 * Structural assertion suite for the contract-reviewer prompt's
 * well-foundedness audit. Reads the shipped agents/gan-contract-reviewer.md
 * from disk and asserts the rewrite documents the factual check, names
 * the committed sprint diff as a new input, instructs the reviewer to
 * open each cited `file:line` and verify the claim against the code, and
 * states the rejection mechanism for finding-derived criteria whose cited
 * code does not exhibit the claim.
 *
 * Why this test exists: the well-foundedness audit is the gate that
 * prevents an ill-founded finding from becoming a real contract criterion
 * the generator must satisfy. The prompt is the only place the role learns
 * the audit's scope, its distinction from well-formedness, and the
 * rejection mechanism — a silent drift in any of these collapses the gate.
 * The test reads the prompt directly because the prompt itself is the
 * load-bearing artefact; a derived representation could mask drift.
 *
 * The literal strings below are expected prompt content, not code; each
 * pin is the spec's wording (well-foundedness named, well-formedness
 * named alongside it, the diff input named, file:line verification
 * instructed, the rejection mechanism for unfounded findings stated).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-reviewer.md');
const prompt = readFileSync(promptPath, 'utf8');

// Locate the Inputs section by heading; assertions about the diff input
// scope to its contents so a stray mention of "diff" elsewhere in the
// prompt does not satisfy the test.
function inputsSection(): string {
  const start = prompt.indexOf('## Inputs');
  expect(start, '## Inputs heading must exist').toBeGreaterThan(-1);
  const rest = prompt.slice(start + '## Inputs'.length);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe('contract_reviewer_prompt_states_well_foundedness_audit', () => {
  it('the prompt contains a well-foundedness section heading or sub-heading', () => {
    // Case-insensitive: the spec wording uses "Well-foundedness audit" as
    // a sub-heading, but the test allows any heading form that names the
    // term so a future re-organisation that preserves the audit under a
    // different heading level still passes.
    expect(prompt.toLowerCase()).toMatch(/#{2,}\s+well-foundedness/);
  });

  it('the prompt distinguishes well-foundedness from well-formedness (both terms appear)', () => {
    // Both terms must be present in the prompt body — the factual check
    // (well-foundedness) is distinct from the shape check
    // (well-formedness). A prompt that names only one term collapses the
    // distinction.
    const lower = prompt.toLowerCase();
    expect(lower).toContain('well-foundedness');
    expect(lower).toContain('well-formedness');
  });

  it('the prompt names the factual check explicitly (distinct from well-formedness)', () => {
    // The factual framing — "is the cited defect actually exhibited by
    // the code?" or substantively equivalent prose — must appear. The
    // test looks for the word "factual" since the spec uses it as the
    // anchor term for the distinction.
    expect(prompt.toLowerCase()).toContain('factual');
  });

  it('the prompt instructs the reviewer to open the cited file:line and verify the claim against the code', () => {
    // Pin two anchors: the file:line cite pattern and the verb that
    // tells the reviewer what to do with it. The 400-character window
    // keeps both anchors inside a single instruction, not scattered.
    const lower = prompt.toLowerCase();
    const fileLineIdx = lower.indexOf('file:line');
    expect(fileLineIdx, 'prompt must reference the file:line cite form').toBeGreaterThan(-1);
    // Search the surrounding context for a verification verb that ties
    // the cite to the verification action. Any of "open", "verify",
    // "confirm" within the window satisfies the check.
    const window = lower.slice(Math.max(0, fileLineIdx - 200), fileLineIdx + 400);
    expect(window).toMatch(/open/);
    expect(window).toMatch(/verify|confirm/);
  });
});

describe('contract_reviewer_prompt_declares_diff_input', () => {
  it('the Inputs section names the committed sprint diff as a new input', () => {
    // The "diff" substring must appear in the Inputs section — the spec
    // wording uses "committed sprint diff" but a future re-phrasing
    // that preserves the substring still passes.
    expect(inputsSection().toLowerCase()).toContain('diff');
  });

  it('the Inputs section explains the diff is the input used to verify finding-derived criteria', () => {
    // The diff input is only meaningful when the Inputs section ties it
    // to the well-foundedness audit (the reason it was added). The test
    // looks for "finding" or "well-foundedness" inside the same section
    // so the diff is anchored to its purpose, not declared in isolation.
    const section = inputsSection().toLowerCase();
    expect(section).toMatch(/finding|well-foundedness/);
  });

  it('the Inputs section preserves the existing draft-contract input alongside the new diff input', () => {
    // The diff input is additive, not a replacement; the existing draft
    // contract input must still be named in the Inputs section.
    expect(inputsSection().toLowerCase()).toContain('contract draft');
  });
});

describe('contract_reviewer_prompt_states_reject_unfounded_finding_criterion', () => {
  it('the prompt explicitly states the rejection mechanism for ill-founded finding-derived criteria', () => {
    // The prompt must name the rejection mechanism — a finding-derived
    // criterion whose cited code does not exhibit the claim is rejected.
    // The spec wording uses "ill-founded" or "ill-formed" for the
    // rejection verdict; either is acceptable.
    const lower = prompt.toLowerCase();
    expect(lower).toMatch(/ill-founded|ill-formed/);
  });

  it('the prompt ties the rejection to the "cited code does not exhibit the claim" trigger', () => {
    // Pin the trigger condition: the rejection is justified by the
    // cited code failing to exhibit the claimed defect. The spec
    // wording uses "does not exhibit" or "does not actually exhibit".
    expect(prompt.toLowerCase()).toMatch(/does not.{0,40}exhibit/);
  });

  it('the rejection mechanism is named alongside the existing ill-formed mechanisms', () => {
    // The well-foundedness rejection is one of several rejection
    // mechanisms (specificity / out-of-scope / threshold-mangled).
    // The prompt must surface that grouping so the reviewer treats
    // the new mechanism as an extension of the existing ones, not as
    // a parallel flow.
    const lower = prompt.toLowerCase();
    // The "unfounded findings" anchor — the spec names the rejection
    // mechanism for unfounded findings explicitly. The phrase appears
    // in the well-foundedness audit section near the rejection rule.
    expect(lower).toMatch(/unfounded findings/);
  });
});
