/**
 * Structural assertion suite for the proposer prompt's surviving-findings
 * payload contract. Reads the shipped agents/gan-contract-proposer.md from
 * disk and asserts the "Inputs" section names surviving-findings as a
 * fourth payload kind alongside the existing revision-notes / objection /
 * blocking-concern payloads.
 *
 * Why this test exists: the renegotiation loop's contract author handoff
 * is structurally a fourth re-spawn payload kind. The proposer must
 * recognise the payload and apply the no-duplication discipline (add a
 * suggested criterion only when it maps to no existing criterion).
 * Forgetting the payload kind silently drops every reviewer finding on
 * the floor without the orchestrator noticing — the prompt is the only
 * place the proposer is told to look for the payload.
 *
 * Each literal string here is expected prompt content; the wording is
 * the spec's wording (each kind named, the renegotiation-round framing
 * present, the no-duplication rule stated).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-proposer.md');
const prompt = readFileSync(promptPath, 'utf8');

// Locate the Inputs section by heading; the assertions scope to its
// contents so a mention of "surviving-findings" in an unrelated section
// (e.g. an example output) does not satisfy the test.
function inputsSection(): string {
  const start = prompt.indexOf('## Inputs');
  expect(start, '## Inputs heading must exist').toBeGreaterThan(-1);
  const rest = prompt.slice(start + '## Inputs'.length);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe('proposer_prompt_documents_surviving_findings_payload', () => {
  it('the Inputs section names "surviving-findings" as a payload kind', () => {
    expect(inputsSection().toLowerCase()).toContain('surviving-findings');
  });

  it('names all four re-spawn payload kinds together (revision-notes, objection, blocking-concern, surviving-findings)', () => {
    // The four payload names must all appear in the Inputs section. The
    // bullet that lists them is the most readable place; a future
    // refactor that splits them across multiple paragraphs is allowed,
    // but every name must remain inside the Inputs section.
    const section = inputsSection().toLowerCase();
    for (const kind of ['revision-notes', 'objection', 'blocking-concern', 'surviving-findings']) {
      expect(section, `payload kind ${kind} must be named in Inputs`).toContain(kind);
    }
  });

  it('the renegotiation-round framing for surviving-findings is present', () => {
    // The spec body anchors the payload to the renegotiation loop — that
    // framing is what tells the proposer the payload arrives only on
    // re-spawn, not on first-attempt contract authoring. The prompt
    // must surface the phrase so the proposer does not treat the
    // payload as a routine input.
    expect(inputsSection().toLowerCase()).toContain('renegotiation round');
  });

  it('states the no-duplication discipline: add criteria only when no existing criterion covers them', () => {
    // The rule that prevents the proposer from emitting one criterion
    // per finding even when the existing draft already covers the
    // claimed defect. The prompt must spell out the "only when it maps
    // to no existing criterion" guard so the proposer does not flood
    // the contract.
    const section = inputsSection().toLowerCase();
    expect(section).toMatch(/only when it maps to no existing criterion|no duplication|do not duplicate/i);
  });

  it('points at the suggestedCriterion field as the source the proposer adopts from each finding', () => {
    // Each surviving finding carries a suggestedCriterion the proposer
    // uses verbatim (or as a starting point). The prompt names the
    // field so the proposer knows which field of the payload to read.
    expect(inputsSection()).toContain('suggestedCriterion');
  });
});
