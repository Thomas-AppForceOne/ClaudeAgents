
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeResolvedConfig } from '../../src/config-server/resolution/resolved-config.js';
import { clearResolvedConfigCache } from '../../src/config-server/resolution/cache.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const fixturePath = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'generic-fallback');

const E1_SPEC_RELATIVE = 'specifications/E1-agent-integration.md';
const e1SpecPath = path.join(repoRoot, ...E1_SPEC_RELATIVE.split('/'));
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

beforeEach(() => clearResolvedConfigCache());
afterEach(() => clearResolvedConfigCache());

function extractNudgeFromSpec(): string {
  const e1 = readFileSync(e1SpecPath, 'utf8');
  const lines = e1.split('\n');
  const line22 = lines[21];

  const startMarker = 'No recognised';
  const endMarker = 'as a starting point.';
  const start = line22.indexOf(startMarker);
  const end = line22.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error(
      `extractNudgeFromSpec: could not locate the nudge markers in E1 line 22. ` +
        `Either the spec moved the line or the nudge wording changed; update this test.`,
    );
  }
  return line22.slice(start, end + endMarker.length);
}

describe('first-run nudge — E1 line 22 contract end-to-end', () => {
  it('generic-fallback fixture activates ONLY generic AND SKILL.md carries the verbatim E1 line 22 nudge string', async () => {

    const resolved = await composeResolvedConfig(fixturePath, { packageRoot: repoRoot });
    expect(resolved.stacks.active).toEqual(['generic']);
    expect(Object.keys(resolved.stacks.byName)).toEqual(['generic']);
    const generic = resolved.stacks.byName.generic;
    expect(generic).toBeDefined();
    if (generic !== undefined) {
      expect(generic.tier).toBe('builtin');
    }

    const nudgeFromSpec = extractNudgeFromSpec();
    expect(nudgeFromSpec.length).toBeGreaterThan(20);

    expect(nudgeFromSpec).toMatch(/generic defaults/);
    const skill = readFileSync(skillPath, 'utf8');
    expect(skill).toContain(nudgeFromSpec);
  });
});
