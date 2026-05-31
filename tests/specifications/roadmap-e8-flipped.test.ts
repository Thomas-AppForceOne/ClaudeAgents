/**
 * Regression guard for the M4 roadmap flip + Next-marker advance to O2.
 *
 * Filename note: this file outlived the E8 flip it was originally
 * authored for and now guards the M4 flip; the rename to
 * `roadmap-m4-flipped.test.ts` is deferred to keep the M4 diff narrow.
 * Each flip's guard is a one-shot for that flip — when O2 ships, this
 * file's assertions invert again and must be updated (or replaced) in
 * the O2 diff.
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
 * implementation-order prefix (e.g. `20.`). Returns the raw line.
 *
 * @param lines roadmap file split into lines.
 * @param prefix entry-number prefix including the trailing period.
 */
function findEntryLine(lines: string[], prefix: string): string {
  const match = lines.find((l) => l.trimStart().startsWith(prefix));
  if (!match) throw new Error(`entry ${prefix} not found in roadmap`);
  return match;
}

describe('roadmap M4 entry is flipped to shipped form and the Next marker advances to O2', () => {
  it('entry 20 starts with the shipped-form marker and names the merged PR', () => {
    const lines = loadRoadmapLines();
    const m4 = findEntryLine(lines, '20.');
    // The shipped form is `✅ **[M4](…)** — …. Shipped PR #<n>.`.
    // Substring matches on the two load-bearing tokens (the ✅-bold-M4
    // prefix and the `Shipped PR #` marker) are sufficient — the rest of
    // the line is descriptive prose and may be reworded.
    expect(m4).toMatch(/^\s*20\.\s+✅\s+\*\*\[M4\]/);
    expect(m4).toContain('Shipped PR #');
  });

  it('entry 20 no longer carries the **Next** marker', () => {
    const lines = loadRoadmapLines();
    const m4 = findEntryLine(lines, '20.');
    // The Next marker is the single point in the roadmap that signals
    // "ship this next"; a shipped entry that still carries it is a
    // definition-of-done failure.
    expect(m4).not.toContain('**Next**');
  });

  it('entry 21 (O2) now carries the **Next** marker', () => {
    const lines = loadRoadmapLines();
    const o2 = findEntryLine(lines, '21.');
    // The marker must move forward atomically with the flip; otherwise
    // there is no single point of truth for "what ships next" and the
    // convention silently breaks.
    expect(o2).toContain('**Next**');
    expect(o2).toContain('[O2]');
    // A spec carrying the Next marker has not yet shipped; it must not
    // already display the ✅ shipped-form marker.
    expect(o2).not.toContain('✅');
  });
});
