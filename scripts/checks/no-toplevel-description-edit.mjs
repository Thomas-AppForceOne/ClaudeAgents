#!/usr/bin/env node
/*
 * Regression check: the sprint-2 diff (since the sprint-1 tip marker)
 * makes no edit to the top-level `description` string in
 * schemas/api-tools-v1.json. The catalog prose touch (mentioning runDir /
 * repoKey arguments for the run-scoped tools) is deferred to a later
 * sprint when the global lint sweep runs; sprint 2 only adds per-tool
 * entries.
 *
 * Reads the sprint-1 tip SHA from
 *   .gan-state/runs/<run-id>/sprint-1-tip
 * (the orchestrator-generator handshake writes this file before any
 * sprint-2 commit lands), then runs:
 *   git diff <sprint-1-tip>..HEAD -- schemas/api-tools-v1.json
 * scans added/removed lines, and exits non-zero if any line matching
 *   ^[+\-]\s*"description"\s*:
 * is present.
 *
 * The script accepts the marker path or the run-id directory as
 * argv[2] for portability across runs; without an argument it auto-picks
 * the newest matching marker so a developer running this from a fresh
 * checkout still gets a useful result.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

function locateMarker() {
  // Explicit path wins.
  const argv = process.argv.slice(2);
  if (argv[0] && existsSync(argv[0]) && statSync(argv[0]).isFile()) return argv[0];

  // Case 1: invoked inside the run worktree
  // (`<repo>/.gan-state/runs/<run-id>/worktree`). The marker is the
  // sibling of cwd's parent, at `../sprint-1-tip`.
  const siblingMarker = path.resolve(process.cwd(), '..', 'sprint-1-tip');
  if (existsSync(siblingMarker) && statSync(siblingMarker).isFile()) return siblingMarker;

  // Case 2: cwd has a .gan-state/runs/ tree under it. Pick the newest
  // sprint-1-tip across all runs.
  const runsDir = path.resolve(process.cwd(), '.gan-state', 'runs');
  if (existsSync(runsDir)) {
    let newest = null;
    let newestMtime = -Infinity;
    for (const name of readdirSync(runsDir)) {
      const candidate = path.join(runsDir, name, 'sprint-1-tip');
      if (!existsSync(candidate)) continue;
      const st = statSync(candidate);
      if (st.mtimeMs > newestMtime) {
        newestMtime = st.mtimeMs;
        newest = candidate;
      }
    }
    if (newest !== null) return newest;
  }
  return null;
}

const marker = locateMarker();
if (!marker) {
  console.error(
    'no-toplevel-description-edit: no sprint-1 tip marker found. The orchestrator-generator handshake writes .gan-state/runs/<run-id>/sprint-1-tip before any sprint-2 commit.',
  );
  process.exit(1);
}

const tip = readFileSync(marker, 'utf8').trim();
if (!/^[0-9a-f]{7,40}$/i.test(tip)) {
  console.error(
    `no-toplevel-description-edit: sprint-1 tip marker '${marker}' is not a SHA: '${tip}'`,
  );
  process.exit(1);
}

let diff = '';
try {
  diff = execFileSync('git', ['diff', `${tip}..HEAD`, '--', 'schemas/api-tools-v1.json'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
} catch (e) {
  console.error(`no-toplevel-description-edit: git diff failed: ${e.message}`);
  process.exit(1);
}

// Only top-level description: match lines that look like description-key
// changes outside an inputSchema's nested description (per-tool input
// schemas in this catalog do not currently carry their own "description"
// at the top of an entry, so any matching line is a real top-level edit).
const pattern = /^[+\-]\s*"description"\s*:/m;
if (pattern.test(diff)) {
  console.error(
    'no-toplevel-description-edit: a "description" key was added or removed in schemas/api-tools-v1.json by sprint 2. The top-level catalog description prose touch is deferred to a later sprint.',
  );
  console.error('---');
  // Print only the offending hunks (cheap: print the whole diff — the
  // catalog file is small).
  console.error(diff);
  process.exit(1);
}

console.log('no-toplevel-description-edit: ok (sprint-2 diff carries no description-line edit)');
