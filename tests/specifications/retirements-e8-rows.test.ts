/**
 * Regression guard for the four retirement-table rows the E8 spec adds.
 *
 * The retirement-table convention (`specifications/retirements.md`) says
 * every prompt file an implementation rewrites in place must carry a
 * matching row attributing the rewrite to its spec and naming the
 * mechanism (`M` for in-place rewrite). Without a guard the rows can
 * silently drift — a future cleanup that "tidies the table" could drop a
 * row and leave the rewrite undocumented.
 *
 * The assertions check three substrings per row (the artefact path, the
 * `| E8 |` attribution cell, and the `M` mechanism marker) rather than
 * deep table parsing. The substring check is deliberately loose — the
 * row's descriptive prose may be reworded over time, but the three
 * load-bearing tokens identify the row uniquely.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Load `specifications/retirements.md` as a single string.
 *
 * Returned as one string (not split into lines) because each row is one
 * line and a substring check across the whole file is cheaper and clearer
 * than a per-line iteration.
 */
function loadRetirements(): string {
  const abs = path.join(REPO_ROOT, 'specifications', 'retirements.md');
  return readFileSync(abs, 'utf8');
}

// The four artefact paths E8 rewrites in place. Each path appears verbatim
// in its retirement row, so a substring search on the path is sufficient
// to locate the row.
const E8_REWRITTEN_PATHS = [
  'agents/gan-evaluator.md',
  'agents/gan-contract-proposer.md',
  'agents/gan-contract-reviewer.md',
  'skills/gan/SKILL.md',
] as const;

describe('retirements.md carries an E8-attributed row for each prompt file E8 rewrote in place', () => {
  for (const artefactPath of E8_REWRITTEN_PATHS) {
    // Each row asserted independently so a missing row surfaces as a
    // single failure naming the missing path, not as one combined "table
    // shape wrong" failure that leaves the reader hunting.
    it(`names ${artefactPath} attributed to E8 with the M mechanism`, () => {
      const body = loadRetirements();
      // Locate every row containing this artefact path. A path may appear
      // in multiple rows (E1 row + Q5 row + E8 row for evaluator/proposer);
      // the E8 row is the one whose attribution cell reads `| E8 |`.
      const rows = body.split('\n').filter((l) => l.includes(`\`${artefactPath}\``));
      const e8Row = rows.find((l) => l.includes('| E8 |'));
      // The E8 row MUST exist — if it does not, the retirement
      // convention is violated for this artefact.
      expect(e8Row).toBeDefined();
      // The mechanism marker is the backtick-wrapped `M` token; rows that
      // attribute the rewrite to a different mechanism (e.g. `D`) would
      // still match `| E8 |` but break the convention.
      expect(e8Row).toMatch(/`M`/);
    });
  }
});
