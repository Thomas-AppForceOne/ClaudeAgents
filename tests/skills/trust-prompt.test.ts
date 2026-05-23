// Content guard for the shipped `skills/gan/trust-prompt.md` (the R5 S4 trust
// prompt presented to the user when a project's config is untrusted). It reads
// the actual file and asserts the load-bearing fragments are present verbatim:
// a top-level heading, every choice token ([v]/[a]/[r]/[c]), the exact
// approvedCommit-aware `git diff` and `git log` review suggestions, and the
// disclosure that invoked scripts are NOT covered by the trust hash. These are
// the user-facing affordances and the security caveat; this test keeps an edit
// to the prose from silently dropping any of them.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve the prompt relative to this test file's location (../../ up to the
// repo root, then into the shipped skills tree).
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const promptPath = path.join(repoRoot, 'skills', 'gan', 'trust-prompt.md');

describe('skills/gan/trust-prompt.md (R5 S4)', () => {
  const content = readFileSync(promptPath, 'utf8');

  it('starts with a top-level Markdown heading (`# `)', () => {
    expect(content.startsWith('# ')).toBe(true);
  });

  it('lists every choice token: [v], [a], [r], [c]', () => {
    expect(content).toContain('[v]');
    expect(content).toContain('[a]');
    expect(content).toContain('[r]');
    expect(content).toContain('[c]');
  });

  it('includes the verbatim approvedCommit-aware git diff suggestion', () => {
    expect(content).toContain('git diff <approvedCommit>..HEAD -- .claude/gan/');
  });

  it('includes the verbatim git log fallback', () => {
    expect(content).toContain('git log -- .claude/gan/');
  });

  it('discloses that invoked scripts are not covered by the trust hash', () => {
    expect(content).toContain('NOT in the hash');
  });
});
