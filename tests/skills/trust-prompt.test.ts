
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

  it('discloses that invoked scripts are not covered by the trust hash', () => {
    expect(content).toContain('NOT in the hash');
  });
});
