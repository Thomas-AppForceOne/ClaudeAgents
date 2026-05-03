/**
 * R5 sprint 4 — static content assertions for `skills/gan/trust-prompt.md`.
 *
 * The trust prompt is markdown the orchestrator (E1) presents to the
 * user. The file must contain every locked substring from R5's prompt
 * design (the `[v]` / `[a]` / `[r]` / `[c]` choice grid plus the two
 * `git diff` / `git log` follow-ups) so the discriminator can verify
 * the prompt without parsing markdown.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

  it('warns that the trust hash does not transitively cover invoked scripts', () => {
    expect(content).toContain('does not transitively cover');
  });
});
