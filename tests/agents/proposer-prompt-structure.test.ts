/**
 * gan-contract-proposer prompt-structure suite — reads the SHIPPED
 * agents/gan-contract-proposer.md verbatim and asserts the proposer is told to
 * source documentation criteria the same disciplined way it sources security
 * criteria, keeping prompt and stack-data contract aligned.
 *
 * What it guards:
 * - a dedicated "Sourcing documentation criteria" section exists and names
 *   documentationSurfaces (specifically snapshot.activeStacks[*].documentation-
 *   Surfaces) as its source array.
 * - the four-step protocol: intersect triggers.scope with the stack's own
 *   scope, gate on triggers.keywords, copy the template VERBATIM (no
 *   interpolation), and require a rationale — stated to be the IDENTICAL
 *   protocol as the security section, and that a neither-trigger surface
 *   instantiates unconditionally on any in-scope touched file.
 * - keying discipline: criteria are keyed by `<stack-name>.<surface-id>`, the
 *   prompt explicitly does NOT deduplicate by bare id, and doc + security
 *   surface ids share one namespace.
 * - the "What you do not do" list forbids restating any documentation standard,
 *   asserting the standard lives only in the stacks' documentationSurfaces, not
 *   in the prompt.
 *
 * Boundary discipline: the documentation section must leak no repo-internal
 * process references and no ecosystem-specific tokens (lint-no-stack-leak).
 *
 * documentationSection() isolates that one section (heading to next `## `) so
 * the leak and protocol checks target it precisely. All string/regex literals
 * are expected prompt content, not code.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'agents', 'gan-contract-proposer.md');
const prompt = readFileSync(promptPath, 'utf8');

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

    expect(section).toContain('triggers.scope');
    expect(section.toLowerCase()).toContain("stack's own `scope`");

    expect(section).toContain('triggers.keywords');

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
