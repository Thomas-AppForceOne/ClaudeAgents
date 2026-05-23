/**
 * Q5 Sprint 2 — structure check for the contract-proposer prompt.
 *
 * Covers contract criteria:
 *  - proposer_prompt_has_documentation_sourcing_section (FUNC-1)
 *  - proposer_keys_by_qualified_id_never_dedups (FUNC-2)
 *  - proposer_forbids_restating_documentation_standard (FUNC-3)
 *  - proposer_prose_no_repo_internal_leak (HYG-5)
 *
 * The proposer is an LLM prompt, not a pure function — the deterministic
 * instantiation behaviour is golden-tested in
 * `evaluator-core/documentation-surfaces.test.ts`. This test asserts the
 * human-facing parallel: that the prompt grew a "Sourcing documentation
 * criteria" section structurally parallel to the security section, keyed
 * by the qualified `<stack>.<id>` namespace, with a "What you do not do"
 * item forbidding a restated documentation standard, and that the new
 * prose leaks no repo-internal process references.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-proposer.md');
const prompt = readFileSync(promptPath, 'utf8');

/**
 * The slice of the prompt from the documentation-sourcing heading to the
 * next top-level heading. Several assertions scope to this slice so a
 * token that happens to appear elsewhere in the prompt (e.g. in the
 * pre-existing security section) cannot make a documentation-section
 * assertion pass spuriously.
 */
function documentationSection(): string {
  const start = prompt.indexOf('## Sourcing documentation criteria');
  expect(start, 'documentation-sourcing heading must exist').toBeGreaterThan(-1);
  const rest = prompt.slice(start + '## Sourcing documentation criteria'.length);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

describe('proposer_prompt_has_documentation_sourcing_section', () => {
  it('has a "Sourcing documentation criteria" section heading', () => {
    expect(prompt).toContain('## Sourcing documentation criteria');
  });

  it('the section references documentationSurfaces as its source array', () => {
    expect(documentationSection()).toContain('documentationSurfaces');
    expect(documentationSection()).toContain('snapshot.activeStacks[*].documentationSurfaces');
  });

  it('the section documents the four-step protocol (intersect scope, keyword gate, verbatim template, rationale)', () => {
    const section = documentationSection();
    // Step 2: scope intersection against both triggers.scope and the stack scope.
    expect(section).toContain('triggers.scope');
    expect(section.toLowerCase()).toContain("stack's own `scope`");
    // Step 3: keyword gate.
    expect(section).toContain('triggers.keywords');
    // Step 4: verbatim template, no interpolation, evidence as rationale.
    expect(section).toContain('verbatim');
    expect(section.toLowerCase()).toContain('no interpolation');
    expect(section.toLowerCase()).toContain('rationale');
  });

  it('the section is structurally parallel to the security section (states it is the identical protocol)', () => {
    expect(documentationSection().toLowerCase()).toMatch(/identical.{0,40}protocol/);
  });

  it('the section states the neither-trigger surface instantiates on any in-scope touched file', () => {
    expect(documentationSection().toLowerCase()).toContain('unconditionally');
  });
});

describe('proposer_keys_by_qualified_id_never_dedups', () => {
  it('the documentation section keys criteria by <stack-name>.<surface-id>', () => {
    expect(documentationSection()).toContain('<stack-name>.<surface-id>');
  });

  it('the documentation section states it does not deduplicate by bare id', () => {
    // Tolerate the markdown emphasis around "not" (`**not**`) between the
    // two words, so the assertion tracks the prose, not the markup.
    expect(documentationSection().toLowerCase()).toMatch(
      /do (\*\*)?not(\*\*)? deduplicate by bare id/,
    );
  });

  it('the documentation section states the documentation and security surface ids share one namespace', () => {
    expect(documentationSection().toLowerCase()).toContain('namespace');
  });
});

describe('proposer_forbids_restating_documentation_standard', () => {
  it('the "What you do not do" list forbids restating any documentation standard', () => {
    expect(prompt).toContain('## What you do not do');
    // The prohibition: do not restate a documentation standard in the prompt.
    expect(prompt).toMatch(/Do \*\*not\*\* restate any documentation standard/i);
  });

  it('states the documentation standard lives only in the stacks, not the prompt', () => {
    expect(prompt.toLowerCase()).toMatch(
      /documentation standard lives only in.{0,80}documentationSurfaces/i,
    );
  });
});

describe('proposer_prose_no_repo_internal_leak', () => {
  it('the documentation section carries no repo-internal process references', () => {
    const section = documentationSection();
    for (const token of ['roadmap.md', 'PROJECT_CONTEXT', 'specifications/', 'CLAUDE.md']) {
      expect(section, `repo-internal leak in documentation section: ${token}`).not.toContain(token);
    }
  });

  it('the documentation section carries no ecosystem-specific tokens', () => {
    const section = documentationSection();
    for (const token of [
      'npm',
      'package.json',
      'package-lock.json',
      'node_modules',
      'pnpm',
      'yarn',
      '.nvmrc',
      'tsconfig.json',
    ]) {
      expect(section, `ecosystem token in documentation section: ${token}`).not.toContain(token);
    }
  });
});
