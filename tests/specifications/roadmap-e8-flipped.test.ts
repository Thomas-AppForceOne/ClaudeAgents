/**
 * Regression guard for the most-recent roadmap flip.
 *
 * Filename note: this file outlived the first flip it was originally
 * authored for and has been rolled forward across subsequent flips; the
 * rename is deferred each time to keep flip diffs narrow. Each flip's
 * guard is a one-shot for that flip — when the next-to-ship entry
 * actually ships, this file's assertions invert again and must be
 * updated (or replaced) in the same diff that ships it.
 *
 * The project convention says a shipped roadmap entry must begin with
 * the shipped marker, name the merged PR, and surrender the
 * `**Next**` marker to the next-to-ship entry. The Next-marker advance is
 * a per-flip decision: a flip whose author elects to defer the advance
 * (because the next-to-ship entry will land in a follow-on PR) leaves the
 * marker temporarily off every entry, which the guard tolerates. The
 * non-negotiable invariant is the shipped form on the just-flipped entry.
 *
 * The test does substring matching rather than deep markdown parsing
 * because the convention is line-level (each entry occupies one line);
 * deep parsing would couple the guard to whichever markdown library
 * happened to be vendored and obscure the actual invariant.
 *
 * Why the PR-number placeholder is tolerated: the orchestrator that
 * authors the flip cannot know the eventual PR number — it only exists
 * after the human opens the PR. The roadmap therefore carries a `<n>`
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

describe('roadmap entry 24 is flipped to shipped form', () => {
  it('entry 24 starts with the shipped-form marker and names the merged PR', () => {
    const lines = loadRoadmapLines();
    const shipped = findEntryLine(lines, '24.');
    // The shipped form is `✅ **[<spec>](…)** — …. Shipped PR #<n>.`.
    // Substring matches on the two load-bearing tokens (the ✅-bold-spec
    // prefix and the `Shipped PR #` marker) are sufficient — the rest of
    // the line is descriptive prose and may be reworded.
    expect(shipped).toMatch(/^\s*24\.\s+✅\s+\*\*\[D1\]/);
    expect(shipped).toContain('Shipped PR #');
  });

  it('entry 24 no longer carries the **Next** marker', () => {
    const lines = loadRoadmapLines();
    const shipped = findEntryLine(lines, '24.');
    // The Next marker is the single point in the roadmap that signals
    // "ship this next"; a shipped entry that still carries it is a
    // definition-of-done failure.
    expect(shipped).not.toContain('**Next**');
  });

  it('entry 25 (next-to-ship) has not been flipped (still no shipped marker)', () => {
    const lines = loadRoadmapLines();
    const next = findEntryLine(lines, '25.');
    // An entry that has not shipped must not display the ✅ shipped-form
    // marker. The **Next** marker advance is deliberately deferred to the
    // PR that ships entry 25 itself, so the guard does not require it
    // here.
    expect(next).not.toContain('✅');
  });
});
