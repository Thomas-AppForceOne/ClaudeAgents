// Content guard for the status-keyed `--recover` resume dispatch in
// skills/gan/SKILL.md.
//
// `--recover` falls through to a dispatch keyed on `progress.json.status`:
// each of the five in-flight status values — `clarifying`, `planning`,
// `negotiating`, `building`, `evaluating` — maps to an explicit re-entry
// behaviour. The `building` branch is load-bearing because it names the
// `sprint-N-base-commit.txt` reset that prevents double-counting of
// prior partial work; the `negotiating` branch is the seam the
// renegotiation-resume path rides. A regression that silently drops one
// status branch would leave that recovery path un-specified, so we pin
// every branch as a separate assertion.
//
// The stranded-self-lock guidance is the distinct refusal `--recover`
// surfaces when the lock at `<store-root>/<repo-key>/run.lock` is held
// by a *live* pid whose `runId` *matches* the recovery target — distinct
// from the generic `ConcurrentRunInProgress` different-`runId` refusal.
// Auto-breaking a same-`runId` live lock could clobber a successor; the
// escape is deliberate manual friction (`rm <lockpath>`). We pin both
// the lock-path naming and the rm escape so a refactor cannot weaken
// the guidance to a generic refusal that looks like a different-run
// conflict.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const skillPath = path.join(repoRoot, 'skills', 'gan', 'SKILL.md');

// The dispatch lives under a `### Recovery resume dispatch` subsection
// inside the top-level `## Cleanup and recovery` block. We slice that
// subsection so a status keyword appearing elsewhere in SKILL.md (for
// example in the renegotiation-status example) cannot mask a missing
// branch in the dispatch itself.
function sliceDispatchSubsection(content: string): string {
  const start = content.indexOf('### Recovery resume dispatch');
  if (start === -1) {
    throw new Error('### Recovery resume dispatch subsection not found in SKILL.md');
  }
  // The dispatch subsection ends at the next `### ` heading or the next
  // top-level `## ` heading, whichever comes first.
  const nextSub = content.indexOf('\n### ', start + 1);
  const nextTop = content.indexOf('\n## ', start + 1);
  const candidates = [nextSub, nextTop].filter((i) => i !== -1);
  const end = candidates.length === 0 ? content.length : Math.min(...candidates);
  return content.slice(start, end);
}

describe('skills/gan/SKILL.md — --recover resume dispatch', () => {
  const content = readFileSync(skillPath, 'utf8');
  const dispatch = sliceDispatchSubsection(content);

  it.each([
    ['clarifying'],
    ['planning'],
    ['negotiating'],
    ['building'],
    ['evaluating'],
  ])('names the %s status branch in the dispatch', (status) => {
    // Each branch must appear as a word in the dispatch subsection.
    // Word-boundary regex so a substring like `re-evaluating` would not
    // satisfy the `evaluating` requirement on its own.
    const re = new RegExp(`\\b${status}\\b`);
    expect(dispatch).toMatch(re);
  });

  it('names sprint-N-base-commit.txt under the building branch', () => {
    // The base-commit reset is what makes a halted `building` sprint
    // resumable without double-counting; an edit that drops the file
    // name would leave the resume mechanism un-specified. We assert
    // both that the file name appears and that it appears within a
    // text window around the `building` branch keyword, so a stray
    // mention elsewhere cannot satisfy the assertion.
    expect(dispatch).toMatch(/sprint-N-base-commit\.txt/);
    const buildingIdx = dispatch.search(/\*\*`building`\*\*/);
    expect(buildingIdx).toBeGreaterThan(-1);
    // Look for the file name within ~600 chars of the `building`
    // bullet; the branch paragraph is one bullet, well under that bound.
    const window = dispatch.slice(buildingIdx, buildingIdx + 600);
    expect(window).toMatch(/sprint-N-base-commit\.txt/);
  });

  it('describes resetting the worktree under the building branch', () => {
    const buildingIdx = dispatch.search(/\*\*`building`\*\*/);
    expect(buildingIdx).toBeGreaterThan(-1);
    const window = dispatch.slice(buildingIdx, buildingIdx + 600);
    // "resets the worktree" anchors the reset action; without it the
    // base-commit naming alone would not specify what the orchestrator
    // does with it.
    expect(window).toMatch(/reset/i);
  });

  it('contains the stranded-self-lock guidance with the lock path and rm escape', () => {
    // The four anchors that together make the guidance actionable:
    // - the literal phrase `stranded-self-lock` identifies the section;
    // - the lock path names where on disk the lock lives;
    // - the rm escape gives the user the deliberate-friction recovery
    //   action distinct from auto-break (which would be unsafe here).
    expect(dispatch).toMatch(/stranded[- ]self[- ]lock/i);
    // The exact lock path the spec names; the regex tolerates a
    // surrounding code-span or angle-brackets.
    expect(dispatch).toMatch(/<store-root>\/<repo-key>\/run\.lock/);
    // The escape: `rm <path>` naming the same lock. Either
    // `rm <lockpath>` or `rm <store-root>/.../run.lock` satisfies; we
    // assert the latter form because the prose names the path
    // explicitly.
    expect(dispatch).toMatch(/rm\s+`?<store-root>\/<repo-key>\/run\.lock`?/);
  });

  it('contrasts the stranded-self-lock case with the generic ConcurrentRunInProgress refusal', () => {
    // The generic different-runId refusal references
    // `ConcurrentRunInProgress` and `EXIT_INVARIANT_VIOLATION` (exit 4);
    // the stranded-self-lock guidance must be presented as distinct
    // from it so a reader can tell which message they are seeing. Both
    // tokens must appear in the dispatch section.
    expect(dispatch).toMatch(/ConcurrentRunInProgress/);
    expect(dispatch).toMatch(/EXIT_INVARIANT_VIOLATION/);
    // The exit-4 numeric reference is part of the same refusal contract;
    // without it a reader cannot reconcile the structured error code
    // with the process exit code.
    expect(dispatch).toMatch(/exit\s*4\b/i);
  });

  it('names emitTraceEvent as the gapless-resume mechanism', () => {
    // The trace continues writing gaplessly via emitTraceEvent +
    // TraceIndex.totalEvents; the dispatch must mention this so a
    // reader knows resume does not require resume-sequence wiring.
    expect(dispatch).toMatch(/emitTraceEvent/);
    expect(dispatch).toMatch(/TraceIndex\.totalEvents/);
  });

  it('marks the terminal-status preflight reject branch [deferred-to-v1.1]', () => {
    // I-003 v1.0 honesty: the preflight enumeration does not include a
    // terminal-status reject, so the dispatch's fall-through behaviour on
    // `complete` / `failed` runs is undefined. The v1.0 surface is the
    // explicit `--run-id <terminal-id>` route (the default selector still
    // pre-filters to non-terminal). The paragraph naming this gap must
    // carry the `[deferred-to-v1.1]` marker so a reader can tell the claim
    // is intentionally documentation-only — mirroring how the `--cleanup`
    // stub above is marked. Pinning the marker on the paragraph that names
    // the terminal-status preflight prevents a re-flow from silently
    // upgrading the prose to "ships in v1.0" without the writer-side
    // preflight subsystem actually landing.
    const lines = dispatch.split('\n');
    const terminalLine = lines.find(
      (l) =>
        /terminal-status/i.test(l) ||
        /RunAlreadyTerminal/.test(l) ||
        (/status/.test(l) && /complete/.test(l) && /failed/.test(l)),
    );
    expect(terminalLine).toBeDefined();
    expect(terminalLine).toMatch(/\[deferred-to-v1\.1\]/);
  });

  it('marks the evaluating malformed-JSON partial-write heuristic [deferred-to-v1.1]', () => {
    // I-004 v1.0 honesty: `sprint-N-feedback-A.json` is written by the
    // gan-evaluator LLM agent through the generic `Write` tool with no
    // atomicity contract, so the "detectable by malformed JSON" heuristic
    // catches only the syntactically-invalid case and misses the
    // cleanly-parsing-but-truncated case. The paragraph stating the
    // heuristic must therefore carry `[deferred-to-v1.1]` so a reader
    // (and CI) can pin which surfaces are intentionally inert in v1.0
    // versus accidentally missing. The marker rides on the `evaluating`
    // branch bullet specifically — the same bullet that contains the
    // "malformed JSON" phrase — so a re-flow that moves the marker
    // elsewhere weakens this assertion.
    const buildingIdx = dispatch.search(/\*\*`evaluating`\*\*/);
    expect(buildingIdx).toBeGreaterThan(-1);
    // The branch bullet plus its deferral paragraph fits within a generous
    // window; the malformed-JSON sentence must land inside the same window
    // as the `[deferred-to-v1.1]` marker so the two are paired in prose.
    const window = dispatch.slice(buildingIdx, buildingIdx + 2000);
    expect(window).toMatch(/malformed JSON/);
    expect(window).toMatch(/\[deferred-to-v1\.1\]/);
  });
});
