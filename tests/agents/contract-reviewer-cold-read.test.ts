/**
 * Structural assertion suite for the contract-reviewer prompt's cold-read
 * framing, first-pass script-name resolution, and verdict-shape pin.
 *
 * Reads the shipped `agents/gan-contract-reviewer.md` from disk and asserts
 * the rewrite carries:
 *  (i) fresh-context / cold-read / skeptical-senior framing, structurally
 *      placed at the top of the reviewer's role description so it lands
 *      before any audit instruction;
 *  (ii) an explicit instruction to run script-name resolution against
 *       `package.json` at the run's base commit on first-pass drafts (not
 *       only on renegotiation rounds);
 *  (iii) the canonical `"verdict"` JSON key documented in the output shape
 *        AND the absence of the legacy `"decision"` spelling.
 *
 * Why this test exists: each of the three drift modes the introducing spec
 * names is silent at orchestration time. A reviewer prompt that loses its
 * cold-read framing degrades into rubber-stamping; a prompt whose
 * well-formedness audit skips first-pass drafts misses fabricated `npm run`
 * names until a finding surfaces them; a prompt that emits two verdict-key
 * spellings silently breaks the join downstream consumers depend on. The
 * tests pin each property against the shipped prompt directly.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-reviewer.md');
const prompt = readFileSync(promptPath, 'utf8');

describe('contract_reviewer_prompt_carries_cold_read_framing', () => {
  it('contains at least one cold-read / fresh-context / skeptical-senior phrase', () => {
    // Mirrors the `grep -iE 'cold[- ]read|fresh context|skeptical senior'`
    // check the introducing spec's proof-of-done names. The phrase wording
    // can be reworked across revisions; the test passes as long as at least
    // one of the three semantic anchors survives.
    expect(prompt).toMatch(/cold[- ]read|fresh context|skeptical senior/i);
  });

  it('framing is structurally placed before the responsibilities section', () => {
    // The framing must land before the audit instructions so the reviewer
    // reads with cold-read posture from the first audit. A framing that
    // appears only after the audits is too late to affect them.
    const framingIdx = prompt.search(/cold[- ]read|fresh context|skeptical senior/i);
    const responsibilitiesIdx = prompt.indexOf('## Your responsibilities');
    expect(framingIdx).toBeGreaterThan(-1);
    expect(responsibilitiesIdx).toBeGreaterThan(-1);
    expect(framingIdx).toBeLessThan(responsibilitiesIdx);
  });
});

describe('contract_reviewer_runs_script_name_resolution_on_first_pass', () => {
  it('the well-formedness audit names script-name resolution explicitly', () => {
    // The audit must mention script-name resolution; without an explicit
    // instruction the reviewer falls back to the prior shape-only check
    // (specificity / comprehensiveness / scope / threshold) that missed
    // fabricated names in the observed defect.
    const lowered = prompt.toLowerCase();
    expect(lowered).toMatch(/script[- ]name resolution|resolve.*script|script.*resolve/);
  });

  it('the audit names "first-pass" drafts so the resolution fires before any renegotiation', () => {
    // The audit must explicitly cover first-pass drafts. A wording that
    // only mentions "renegotiation rounds" or "finding-derived criteria"
    // reproduces the observed gap.
    expect(prompt).toMatch(/first[- ]pass/i);
  });

  it('the audit names the script-runner invocation form and the project script map (the resolution target)', () => {
    // The two anchors that pin the audit to the same surface the proposer-
    // side pre-flight operates on. Without them, the reviewer might apply
    // a divergent resolution and disagree with the proposer's pre-flight.
    // Phrasing is ecosystem-neutral: the agent prompt does not name a
    // specific ecosystem's runner ("npm", "yarn", "pnpm", "bun", ...) so the
    // shipped prompt stays clean under the no-stack-leak lint; the test
    // pins the semantic anchors ("script-runner invocation", "script map")
    // rather than ecosystem-specific tokens.
    const lowered = prompt.toLowerCase();
    expect(lowered).toContain('script-runner');
    expect(lowered).toContain('script map');
  });

  it('an unresolved reference is named as blocking approval', () => {
    // The audit must state the blocking semantics. A wording that surfaces
    // unresolved references advisorily would let a fabricated name reach
    // the evaluator anyway.
    const lowered = prompt.toLowerCase();
    expect(lowered).toMatch(/issues\[\]|block.*approval|approval.*block/);
  });
});

describe('contract_reviewer_emits_canonical_verdict_shape', () => {
  it('the prompt documents the `"verdict"` JSON key at least twice (approved + revise examples)', () => {
    // Mirrors the `grep -c '"verdict"' ≥ 2` check the introducing spec's
    // proof-of-done names. Both the approved and revise example documents
    // must use the same canonical spelling.
    const matches = prompt.match(/"verdict"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('the prompt emits zero occurrences of the deprecated `"decision"` JSON key', () => {
    // Mirrors the `grep -c '"decision"' == 0` check the introducing spec's
    // proof-of-done names. The deprecated alternative spelling must be
    // absent so downstream consumers can join on `"verdict"` alone.
    const matches = prompt.match(/"decision"/g) ?? [];
    expect(matches.length).toBe(0);
  });

  it('the canonical verdict values appear ("approved" and "revise") next to the verdict key', () => {
    // The two-value enum is part of the join contract. A prompt that drops
    // either value would degrade the verdict-shape pin to a key check only.
    expect(prompt).toContain('"approved"');
    expect(prompt).toContain('"revise"');
  });
});
