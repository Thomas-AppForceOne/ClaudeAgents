/**
 * Structural prompt assertions over `agents/gan-evaluator.md` for the
 * sole-gate discretion clause (sprint-5 feature 20 / clarified-spec §5).
 *
 * Why structural: "sole-gate preservation" must be visible in the prompt
 * itself so the evaluator reads it at score time. A finding the independent
 * reviewer raises that the proposer turns into a criterion may, on inspection
 * by the evaluator, be benign — and the prompt must explicitly permit a
 * `pass` verdict in that case so a benign finding does not force a
 * spurious failure. Without that permission stated, the LLM would default to
 * the cautious failure path and the reviewer would become a parallel gate in
 * practice, which is exactly what §5 forbids.
 *
 * Two guarded properties:
 * 1. The prompt explicitly states the evaluator MAY score a finding-derived
 *    criterion as PASS when the flagged code is, on inspection, correct.
 * 2. The prompt locates this discretion in the three-role architecture: the
 *    reviewer raises *what gets asked*; the evaluator decides *whether it
 *    passed*; the evaluator remains the sole gate.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-evaluator.md');
const prompt = readFileSync(promptPath, 'utf8');

describe('evaluator_prompt_documents_sole_gate_discretion', () => {
  it('the prompt explicitly states the evaluator MAY score a finding-derived criterion as pass', () => {
    // The exact MAY-permission phrasing. The case-sensitive MAY mirrors the
    // prompt's MUST/SHOULD/MAY vocabulary used elsewhere as the rule-binding
    // signal — a lowercase "may" would be weaker and intentionally fails.
    expect(prompt).toMatch(/MAY score a finding-derived criterion as (`pass`|pass)/);
  });

  it('states a benign finding does NOT force a failure', () => {
    expect(prompt).toMatch(/benign finding does (\*\*)?not(\*\*)? force a failure/i);
  });

  it('locates the discretion in the three-role split (reviewer raises what gets asked; evaluator decides whether it passed)', () => {
    // The sentence is the §5 epigram. Keeping it byte-checkable prevents a
    // future rewrite from quietly elevating the reviewer or downgrading the
    // evaluator into a notary.
    expect(prompt).toMatch(/what gets asked/);
    expect(prompt).toMatch(/whether it passed/);
  });

  it('explicitly preserves the evaluator as the sole pass/fail gate', () => {
    expect(prompt.toLowerCase()).toContain('sole');
    expect(prompt.toLowerCase()).toMatch(/sole\s+(pass\/?fail\s+)?gate|sole gate/);
  });

  it('mentions the dropped-non-reproducing and contract-reviewer-may-reject paths so the evaluator knows it is not a notary', () => {
    // The two upstream guards: a finding that does not reproduce is dropped
    // before becoming a criterion (sprint 1), and the contract-reviewer may
    // reject an ill-formed finding-derived criterion (sprint 4). The prompt
    // must surface both so the evaluator's discretion is the third guard,
    // not the only one.
    expect(prompt.toLowerCase()).toMatch(/not.{0,30}reproduce|dropped/);
    expect(prompt.toLowerCase()).toContain('contract-reviewer');
    expect(prompt.toLowerCase()).toMatch(/(reject|ill-formed)/);
  });
});
