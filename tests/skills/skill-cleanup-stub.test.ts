// Content guard for the v1.0 `--cleanup` stub in skills/gan/SKILL.md.
//
// The prior shipped prose enumerated a seven-step destructive flow
// (validateAll -> resolve targets -> active-run guard -> preview/confirm
// -> per-run teardown -> prune -> report). v1.0 ships only the inert
// stub: invoking `--cleanup` (with any modifier) prints the structured
// `this command requires v1.1` message, exits non-zero, and mutates
// nothing on disk. The destructive surface lands in v1.1 by wiring the
// already-tested cleanup-planner library as a deterministic tool / CLI.
//
// We pin the four invariants on the `--cleanup` section specifically
// (sliced from the broader `## Cleanup and recovery` block by header
// regex) so a regression that re-introduces a destructive verb under
// the dispatch heading fails this test rather than CI's grep-only lint.
// The sibling regular-recovery prose under the same `## Cleanup and
// recovery` heading is intentionally out of scope here — the `--recover`
// path stays operative in v1.0 and may legitimately reference paths the
// cleanup stub never touches.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root derives from this test file's location to mirror the
// resolution scheme the sibling skill-content tests use; this avoids a
// process.cwd() dependency that would silently break under a different
// test runner invocation.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

// The `## Cleanup and recovery` block is the top-level section the
// contract verifier regex scopes its checks to. The `--cleanup` stub
// lives under a `### --cleanup` subsection inside that block. We slice
// twice: once to the top-level block (for the destructive-verb check,
// matching the contract verifier's scope) and once to the `### --cleanup`
// subsection (for marker + message + contract assertions, so a leak from
// the sibling recovery prose cannot mask a defect inside the stub).
function sliceCleanupBlock(content: string): string {
  const start = content.indexOf('## Cleanup and recovery');
  if (start === -1) {
    throw new Error('## Cleanup and recovery section not found in SKILL.md');
  }
  // Find the next level-2 heading; rely on `\n## ` (newline + double-hash
  // + space) so subsections (`### ...`) inside the block stay included.
  const nextLevelTwo = content.indexOf('\n## ', start + 1);
  return nextLevelTwo === -1 ? content.slice(start) : content.slice(start, nextLevelTwo);
}

function sliceCleanupSubsection(content: string): string {
  const block = sliceCleanupBlock(content);
  // The stub lives under a `### --cleanup` subsection. We slice from
  // that heading up to the next `### ` or end-of-block so a sibling
  // subsection (e.g. the recovery resume dispatch) does not bleed into
  // the assertions about the stub itself.
  const subStart = block.indexOf('### --cleanup');
  if (subStart === -1) {
    throw new Error('### --cleanup subsection not found inside Cleanup and recovery block');
  }
  const nextSub = block.indexOf('\n### ', subStart + 1);
  return nextSub === -1 ? block.slice(subStart) : block.slice(subStart, nextSub);
}

describe('skills/gan/SKILL.md — --cleanup v1.0 stub', () => {
  const content = readFileSync(skillPath, 'utf8');
  const block = sliceCleanupBlock(content);
  const stub = sliceCleanupSubsection(content);

  it('carries the [deferred-to-v1.1] marker on the --cleanup subsection heading or lead paragraph', () => {
    // The status-marker discipline requires every deferred surface to declare
    // its `[deferred-to-v...]` marker at the dispatch site so a reader (and
    // this test) can pin which surfaces are intentionally inert vs. which are
    // accidentally missing. We accept the marker on either the heading or the
    // lead paragraph — defensive against a re-flow that moves it inline
    // without weakening the marker requirement itself.
    expect(stub).toMatch(/\[deferred-to-v1\.1\]/);
  });

  it('states the "this command requires v1.1" structured message', () => {
    // The exact phrase the stub prints at runtime; downstream readers
    // (the v1.1 reviewer who wires the destructive surface) will grep
    // for this token to find the stub site.
    expect(stub).toContain('this command requires v1.1');
  });

  it('states the exits-non-zero + mutates-nothing contract', () => {
    // "exits non-zero" anchors the non-zero exit contract; "mutates
    // nothing" anchors the no-on-disk-write contract. The stub must
    // state both so a reader cannot conclude the command is a no-op
    // (which would still allow a partial write on the way out).
    expect(stub).toMatch(/exits non-?zero/i);
    expect(stub).toMatch(/mutates nothing/i);
  });

  it('does not contain the four destructive verbs within the Cleanup and recovery block', () => {
    // The contract verifier regex slices at the `##[^#].*[Cc]leanup`
    // top-level heading; we mirror that scope here so this test fails on
    // exactly the same regression CI would catch via grep, but with a
    // per-verb error message a developer can act on.
    const banned = ['git worktree remove', 'rm -rf', 'git branch -D', 'git push --delete'];
    const hits = banned.filter((b) => block.includes(b));
    expect(hits).toEqual([]);
  });
});
