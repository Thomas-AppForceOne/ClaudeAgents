// Content guard for the renegotiation-loop section of skills/gan/SKILL.md.
//
// The section is the user-visible contract for the framework's renegotiation
// loop: a downstream consumer reads it to learn the six steps, the artefact
// filename the reviewer writes, the advisory-tier non-trigger rule, and the
// contract-lifecycle invariants (canonical filename, archived `.r{k}.json`
// siblings, atomic re-lock). An edit that silently drops any of these would
// be a quiet defect — runtime tooling would still work, but its specification
// would no longer say so. This test pins each load-bearing fragment as a
// separate assertion so a partial regression surfaces as a specific failure
// rather than a vague "section is wrong" check.
//
// The lint-no-spec-ref clean-bill assertion is the boundary discipline: the
// shipped SKILL.md ships in the end-user surface and must never carry a
// `specifications/<CODE>` repo-internal reference. We test this here in
// addition to the linter so a regression caught at edit-time also fails the
// in-process suite (which a developer is more likely to run than the CLI
// lint).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the SKILL.md relative to this test file's location; the path layout
// mirrors trust-prompt.test.ts so adding a sibling test never has to invent a
// new resolution scheme.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

describe('skills/gan/SKILL.md — renegotiation loop section', () => {
  const content = readFileSync(skillPath, 'utf8');

  it('contains the section heading with the [shipped-in-v1.0] marker', () => {
    // The D1 status marker discipline requires every SKILL.md heading to
    // carry its release marker; the renegotiation loop ships in v1.0, so the
    // marker must read [shipped-in-v1.0] (not [partial-v1.0] or any other).
    expect(content).toContain('## Renegotiation loop [shipped-in-v1.0]');
  });

  it('contains the contract-lifecycle section heading with the same marker', () => {
    expect(content).toContain(
      '## Contract lifecycle under renegotiation (re-lock, not mutate) [shipped-in-v1.0]',
    );
  });

  it('names the independent-review artefact filename verbatim', () => {
    // Downstream tooling joins on this exact filename pattern; documenting it
    // here is what makes the join a stable contract.
    expect(content).toContain('sprint-{N}-independent-review-{attempt}.json');
  });

  it('enumerates the six steps in order, each as a numbered list item', () => {
    // The six-step ordering is load-bearing: the well-foundedness audit only
    // makes sense after finding validation; the re-lock only makes sense
    // after the renegotiation round produces a draft; the evaluator gate is
    // last. A regression that reorders them would silently change the loop.
    const stepRegex = /^\d+\.\s/gm;
    const numberedLines = content.match(stepRegex) ?? [];
    // The section enumerates six steps; the rest of SKILL.md uses numbered
    // lists elsewhere (e.g. the regular invocation flow), so we look for the
    // six-step sequence specifically by anchoring to the section heading and
    // counting only within it.
    const sectionStart = content.indexOf('## Renegotiation loop [shipped-in-v1.0]');
    const sectionEnd = content.indexOf('##', sectionStart + 5);
    const section = content.slice(sectionStart, sectionEnd);
    const sectionSteps = section.match(stepRegex) ?? [];
    expect(sectionSteps.length).toBeGreaterThanOrEqual(6);
    // Anchor each step's intent by a substring that uniquely identifies it,
    // so a re-numbered or accidentally-dropped step fails specifically.
    expect(section).toMatch(/1\.\s+\*\*Generator commits/);
    expect(section).toMatch(/2\.\s+\*\*Independent reviewer/);
    expect(section).toMatch(/3\.\s+\*\*Finding validation/);
    expect(section).toMatch(/4\.\s+\*\*Renegotiation round/);
    expect(section).toMatch(/5\.\s+\*\*Re-lock at a new contract revision/);
    expect(section).toMatch(/6\.\s+\*\*Evaluator scores/);
    // The whole-file numbered-line tally only sanity-checks that the regex
    // matched something; the per-step assertions above are the real guard.
    expect(numberedLines.length).toBeGreaterThanOrEqual(6);
  });

  it('states that advisory findings never trigger renegotiation', () => {
    // The advisory-tier rule is the load-bearing exception: a renegotiation
    // round is gated on surviving blockers/warnings, and the spec is exact
    // that advisories do not start one. The substring check anchors the
    // negative case.
    expect(content).toContain('Advisory findings never trigger renegotiation');
  });

  it('names the canonical filename and the archived-sibling scheme', () => {
    // Canonical filename is the join key downstream consumers hardcode; the
    // archived-sibling scheme is the operator-readable history. Both are
    // invariants the section is contracted to declare.
    expect(content).toContain('sprint-{N}-contract.json');
    expect(content).toContain('sprint-{N}-contract.r{k}.json');
  });

  it('names the progress.json.contractRevision field as the revision index', () => {
    expect(content).toContain('progress.json.contractRevision');
  });

  it('names the negotiating status while a round is in flight', () => {
    expect(content).toContain('"negotiating"');
    expect(content).toContain('"building"');
  });

  it('does not introduce a specifications/* repo-internal reference in the new sections', () => {
    // lint-no-spec-ref enforces zero `specifications/<CODE>` references over
    // skills/gan/; the new renegotiation sections must not be the regression
    // that re-introduces such a reference. The check is scoped to the two
    // new section bodies because the rest of SKILL.md may legitimately
    // mention `specifications/<example>.md` as an example user invocation
    // path (not a repo-internal reference); the lint script's allowlist
    // resolves that case and we should not double-fail it here.
    const renegoStart = content.indexOf('## Renegotiation loop [shipped-in-v1.0]');
    const lifecycleStart = content.indexOf(
      '## Contract lifecycle under renegotiation (re-lock, not mutate) [shipped-in-v1.0]',
    );
    const afterLifecycle = content.indexOf('##', lifecycleStart + 5);
    const newSections = content.slice(renegoStart, afterLifecycle);
    expect(newSections).not.toContain('specifications/');
  });
});
