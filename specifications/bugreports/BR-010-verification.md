# BR-010 — Verification

**Verifier model:** opus
**Verdict:** confirmed
**Verified at:** 2026-06-08T00:00:00Z

## Summary

The E8 implementation run (`20260530T231724-5cc0`) shipped `agents/gan-reviewer-independent.md`, `schemas/independent-review-v1.json`, and the bundled-schemas wiring in sprint 1, but produced **zero** `sprint-N-independent-review-A.json` artefacts across all six of its sprints — confirming that the orchestrator did not invoke the freshly-shipped reviewer on any subsequent sprint of the same run. Subsequent runs in other projects do invoke it, confirming the mechanism works once a fresh `/gan` invocation re-captures the snapshot and reloads the agent inventory.

## Reproduction evidence

### Step 1 — list independent-review artefacts in the E8 run

```bash
ls /Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/20260530T231724-5cc0/ | grep independent-review
```

Actual output: empty (exit 1 — grep no-match). Verified by a full directory listing of the run dir, which contains `sprint-{1..6}-{base-commit,contract-draft,contract,evidence-A,review}` artefacts but **no** `sprint-N-independent-review-*.json` files — across all six sprints. (The shipped run-data layout in subsequent runs uses `evaluator-evidence-A/B` and `independent-review-A/B`; the E8 run uses the older `evidence-A` / `review` pair, with no independent-review file at all.)

### Step 2 — confirm the agent is invoked in a subsequent run

```bash
ls /Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/20260531T163227-e220/ | grep independent-review
```

Actual output (exit 0):

```
sprint-1-independent-review-A.json
sprint-1-independent-review-B.json
```

The subsequent run (started 2026-05-31 16:32 — after the E8 run terminated at 2026-05-31 01:56 per `progress.json.finishedAt`) does produce `independent-review` bundles. The mechanism works; it just did not fire inside the run that shipped it.

### Supporting evidence

- `progress.json` for the E8 run shows all six sprints `verdict: "pass"` on the first attempt with 100% criteria pass rates (15/15, 17/17, 17/17, 26/26, 21/21, 20/20), and `status: "complete"`, `terminalReason: "complete"` — i.e. the renegotiation loop never fired and the reviewer never participated.
- Sprint 1 commits (`fba3552..23b723b`) confirm what shipped in sprint 1: `7ed74ae sprint 1: add gan-reviewer-independent agent prompt`, `f514f79 sprint 1: add independent-review-v1 JSON Schema`, `9ebc330 sprint 1: add pure-function reproduction gate for review findings`, `23b723b sprint 1: bundle independent-review-v1 in schemas-bundled.ts`. Sprint 2's `sprint-2-base-commit.txt` (`23b723b...`) is the final commit of sprint 1, so the new agent file was physically present in the worktree throughout sprints 2-6.
- The run's `trace/` directory is empty — this run pre-dates trace integration — so there is no `independentReview` trace event to inspect, but the absence of the on-disk bundle is itself dispositive.

## Root-cause assessment

The cited root cause holds up against the spec.

`skills/gan/SKILL.md` § "Snapshot freshness rule" (lines 300-304) is explicit:

> The captured snapshot is **frozen across user-side edits** for the entire run, including across multiple sprints in a multi-sprint plan. Wall-clock time between sprints does not matter; user edits to overlay or stack files mid-run are not picked up until the next `/gan` invocation.

The re-snapshot trigger is narrowly scoped to `{ mutated: true }` returns from framework API calls (i.e. configuration mutations), not to new files appearing under `agents/` in the worktree. The agent inventory is what Claude Code's session loaded at startup; the `getResolvedConfig()` snapshot does not enumerate `agents/*.md`. There is no "the diff added a file under `agents/` → reload" path.

The chicken-and-egg observation in the report is also accurate: even if there were a hot-reload mechanism, PROJECT_CONTEXT's "implemented specs are immutable" and the framing of `gan-reviewer-independent` as a *gating* criterion source via renegotiation would mean an agent shipped in sprint 1 cannot legitimately be the gate on sprint 1's own merge — the spec-lifecycle invariant the report's "Suggested fix" calls out (advisory mode) is the correct framing.

The structural consequence the report claims — every gate-strengthening PR self-certifies without exercising the new gate — is borne out by this run: the PR that added the reviewer mechanism (`#35`, commit `2c18116`) was graded by sprint contracts and evaluator passes only, with no independent reviewer involvement at any sprint.

## Concerns / caveats

- The E8 run's six sprints all passed first-try (15/15, 17/17, …, 20/20 criteria), so even if the independent reviewer had been live there would have been nothing for the renegotiation loop to escalate (per the renegotiation-loop spec, the reviewer's findings only matter when blocker/warning findings map to no existing criterion). The bug as filed is structural — the file simply doesn't exist — and that observation is independent of whether the reviewer *would* have flagged anything.
- The bug report says "Sprints 2-6 of the same run touched the SKILL.md renegotiation loop, the trace event, the evaluator rewrite, and the planted-defect suite." The E8 spec (`specifications/E8-independent-review-and-forced-verification.md` lines 166-170) lists six slices but I did not enumerate the exact sprint→slice mapping by reading each sprint's contract. The structural claim does not depend on this mapping — the absence of `sprint-N-independent-review-*.json` for every N from 1-6 is the load-bearing observation.
- The bug report says trace events would prove non-invocation, but this E8 run's `trace/` directory is empty (the run was orchestrated before trace events were wired through to the spawn lifecycle for this project) — so the on-disk artefact absence is the only available signal, and it is sufficient.
- Run-data is in `~/.gan-runs-data` (the central store outside the verification worktree), not in the worktree at `~/AppForceOne/projects/ClaudeAgents-verify/.gan-state/`. The verification was done against the central store, which is the canonical location per F7's "centralized run-data store".

## Confidence

high — the on-disk artefacts in the E8 run are unambiguously missing across all six sprints, the same artefact does appear in the very next run on another project, and the spec's snapshot-freshness rule (lines 300-304) is explicit that user-side edits — which the orchestrator cannot distinguish from sprint diffs landing new agent files — are frozen for the entire run.
