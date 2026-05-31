/**
 * Regression guard for the E8 roadmap flip + Next-marker advance.
 *
 * The project convention (PROJECT_CONTEXT § "Shipping a spec flips its
 * roadmap entry") says a shipped spec's `Implementation order` entry must
 * begin with the ✅ marker, name the merged PR, and surrender the
 * `**Next**` marker to the next-to-ship spec. Without a guard the
 * convention can drift the moment a future edit reorders entries.
 *
 * The test does substring matching rather than deep markdown parsing
 * because the convention is line-level (each entry occupies one line);
 * deep parsing would couple the guard to whichever markdown library
 * happened to be vendored and obscure the actual invariant.
 *
 * Why the PR-number placeholder is tolerated: the orchestrator that
 * authors the flip cannot know the eventual PR number — it only exists
 * after the human opens the PR. The roadmap therefore carries a `<TBD>`
 * placeholder (visually flag-worthy) plus an adjacent HTML-comment TODO
 * the human substitutes at PR-open time. The test asserts presence of
 * `Shipped PR #` rather than a literal number.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Read `specifications/roadmap.md` and split it into lines.
 *
 * Isolated so a future relocation of the roadmap surfaces as a single
 * `ENOENT` rather than as ambiguous "line not found" assertion failures.
 */
function loadRoadmapLines(): string[] {
  const abs = path.join(REPO_ROOT, 'specifications', 'roadmap.md');
  return readFileSync(abs, 'utf8').split('\n');
}

/**
 * Locate the first line whose trimmed form starts with the given
 * implementation-order prefix (e.g. `19.`). Returns the raw line.
 *
 * @param lines roadmap file split into lines.
 * @param prefix entry-number prefix including the trailing period.
 */
function findEntryLine(lines: string[], prefix: string): string {
  const match = lines.find((l) => l.trimStart().startsWith(prefix));
  if (!match) throw new Error(`entry ${prefix} not found in roadmap`);
  return match;
}

describe('roadmap E8 entry is flipped to shipped form and the Next marker advances to M4', () => {
  it('entry 19 starts with the shipped-form marker and names the merged PR', () => {
    const lines = loadRoadmapLines();
    const e8 = findEntryLine(lines, '19.');
    // The shipped form is `✅ **[E8](…)** — …. Shipped PR #<n>.`.
    // Substring matches on the two load-bearing tokens (the ✅-bold-E8
    // prefix and the `Shipped PR #` marker) are sufficient — the rest of
    // the line is descriptive prose and may be reworded.
    expect(e8).toMatch(/^\s*19\.\s+✅\s+\*\*\[E8\]/);
    expect(e8).toContain('Shipped PR #');
  });

  it('entry 19 no longer carries the **Next** marker', () => {
    const lines = loadRoadmapLines();
    const e8 = findEntryLine(lines, '19.');
    // The Next marker is the single point in the roadmap that signals
    // "ship this next"; a shipped entry that still carries it is a
    // definition-of-done failure.
    expect(e8).not.toContain('**Next**');
  });

  it('entry 20 (M4) now carries the **Next** marker', () => {
    const lines = loadRoadmapLines();
    const m4 = findEntryLine(lines, '20.');
    // The marker must move forward atomically with the flip; otherwise
    // there is no single point of truth for "what ships next" and the
    // convention silently breaks.
    expect(m4).toContain('**Next**');
    expect(m4).toContain('[M4]');
  });
});
