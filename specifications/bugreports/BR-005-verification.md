# BR-005 — Verification

**Verifier model:** opus
**Verdict:** confirmed
**Verified at:** 2026-06-08T00:00:00Z

## Summary

The bug reproduces exactly as described: the generator wrote a structured objection artefact, the run terminated `complete` without the orchestrator routing the objection to the contract-proposer, and there is no `generator-objection-v1.json` schema in `schemas/`. The orchestrator playbook (`skills/gan/SKILL.md`) contains zero references to "objection"; only the agent prompts and the documentation sequence diagram describe the intended flow.

## Reproduction evidence

### Step 1 — `cat …/sprint-3-objection-A.json`

Exit code: 0. The file exists and is well-formed JSON with the shape the report describes (`sprintNumber`, `attempt`, `target`, `reason`, `proposedChange`):

```
{
  "sprintNumber": 3,
  "attempt": 1,
  "target": "no_unrelated_files_changed vs tests_pass_no_regression",
  "reason": "The contract's affectedFiles allowlist … is internally inconsistent with the tests_pass_no_regression blocker. Two pre-existing one-shot guard tests on develop -- tests/installer/version-bump.test.ts and tests/specifications/roadmap-e8-flipped.test.ts -- pin the prior-state values …",
  "proposedChange": "Add tests/installer/version-bump.test.ts and tests/specifications/roadmap-e8-flipped.test.ts to sprint-3-contract.json's affectedFiles list …"
}
```

The objection target, reason, and proposedChange match the report's narrative (cross-spec conflict between `affectedFiles` allowlist and `tests_pass_no_regression`, citing the two named guard tests).

### Step 2 — `ls schemas/ | grep -i objection`

Exit code: 1 (no match). The shipped `schemas/` directory contains:

```
api-tools-v1.json
evaluator-evidence-bundle-v1.json
independent-review-v1.json
module-config-docker-v1.json
module-manifest-v1.json
overlay-v1.json
progress-v1.json
run-trace-index-v1.json
run-trace-v1.json
stack-v1.json
telemetry-config-v1.json
telemetry-outcome-v1.json
```

No `generator-objection-v1.json` (or any objection-shaped schema). Confirmed.

### Step 3 — `progress.json` status/terminalReason

Exit code: 0. Output:

```
complete complete
```

The run terminated cleanly as `status=complete, terminalReason=complete` despite the unread objection on sprint 3. `progress.json` lacks any `objections[]` field (top-level keys: `baseBranch, completedSprints, contractRevision, currentAttempt, currentSprint, overlaysAtSnapshot, projectRoot, recoveryHistory, runBranch, runId, startingBranch, status, terminal, terminalAt, terminalReason, totalSprints, workspace`).

Run-directory artefacts for sprint 3 are only:

```
sprint-3-base-commit.txt
sprint-3-contract.json
sprint-3-objection-A.json
```

There is no `sprint-3-contract.r1.json` (no revised contract from a proposer renegotiation), no `sprint-3-feedback-*.json` (no evaluator output), and no sprint 4 artefacts. `currentAttempt: 2` in `progress.json` suggests a follow-up generator attempt occurred without writing any further sprint-3 artefacts — consistent with "the orchestrator did not route the objection back to the proposer."

## Root-cause assessment

The cited root cause holds up:

1. **No schema.** Confirmed — `schemas/` contains no `generator-objection-v1.json` or equivalent. The agent prompt at `agents/gan-generator.md:151-169` instructs the generator to write the artefact, but with no schema document the shape is whatever the agent decides on a given run.

2. **No orchestrator handler.** Confirmed — `skills/gan/SKILL.md` (471 lines) contains zero occurrences of the string "objection". The only references to the orchestrator-side route are:
   - `documentation/agent-layer.md:177-181` — a Mermaid sequence diagram showing `SK->>+CP: snapshot + objection payload` and `CP-->>-SK: revised CONTRACT DRAFT`. This is documentation of intent, not orchestrator logic.
   - `agents/gan-contract-proposer.md:21,26,167` — the proposer prompt acknowledges `objection` as one of four re-spawn payload kinds it knows how to consume.
   - `agents/gan-generator.md:62,151-169` — the generator prompt describes how to write the artefact and prints `OBJECTION RAISED for sprint {N} attempt {A}`.

   The writer side (generator), the receiver side (proposer), and the diagram all agree on the protocol. The orchestrator playbook that should detect `sprint-N-objection-*.json`, parse it, and re-spawn the proposer with `payloadKind: "objection"` does not exist — the wiring step between writer and receiver is missing.

3. **Hook permits writes but doesn't dispatch.** `scripts/hooks/gan-confine.sh.template:251` allows the generator to write `sprint-[0-9]*-objection-[0-9A-Za-z]*.json`; the test fixture at `tests/fixtures/hooks/confine-paths.json:86-89` covers it. Hook coverage only guarantees the artefact can land on disk — it does not imply a downstream reader.

4. **The report's claim that "E8 § 2 already names 'objection' as one of the four payload kinds the proposer accepts" checks out** — verified at `agents/gan-contract-proposer.md:21,26` and the dedicated proposer-payload test at `tests/agents/proposer-surviving-findings-payload.test.ts:47-53` which asserts all four payload kinds (`revision-notes`, `objection`, `blocking-concern`, `surviving-findings`) are named together. Receiver-side contract is in place; the dispatch is the only gap.

## Concerns / caveats

- The report says the orchestrator "did not route this back to the contract-proposer; no new contract revision was written from the objection." The run-directory evidence is consistent with this, but `progress.json` shows `currentAttempt: 2` for sprint 3, implying *some* second generator pass occurred. There is no second objection file (the generator's "at most one objection per sprint" budget in `agents/gan-generator.md:167` would explain this) and no revised contract. The most likely interpretation: the generator re-ran against the original sprint-3 contract on attempt B without the proposer ever being consulted, then the run terminated. The orchestrator may treat the OBJECTION-RAISED stdout signal as just another failed attempt rather than as a re-spec trigger. A fix-planner should confirm what the orchestrator does on attempt B after the OBJECTION RAISED stdout line and whether there are intermediate retired-state artefacts.

- The retirement table at `specifications/retirements.md:23,40` records that an older `skills/gan/schemas/objection.schema.json` (legacy run-state schema) was retired during E1 with an explicit "rewrite or drop" decision. The current absence of a re-authored schema is therefore not necessarily an accident — it may have been an explicit drop without a follow-up. Either way, the post-E1 protocol (writer + proposer + diagram) clearly expects a schema and a handler that do not exist; the report's "wiring is the gap" framing remains correct.

- `progress.json`'s lack of an `objections[]` field matches the report's third suggested-fix item ("surface the objection in `progress.json.objections[]`"), and `schemas/progress-v1.json` contains no objection-related field either — so cross-run analysis cannot currently count objections without scanning per-run directories.

- Reproducing on a fresh run would require triggering an unsatisfiable contract / blocker conflict; no automated fixture in `tests/` exercises end-to-end objection handling (the proposer test is purely structural assertion of the prompt's "Inputs" section). The observed dead-letter behaviour is not covered by any test.

## Confidence

high — both literal-output reproduction steps and the orchestrator-search were exhaustive: `skills/gan/SKILL.md` contains zero occurrences of "objection" across 471 lines, no source file under `src/` or `scripts/` reads `sprint-*-objection-*.json`, and the on-disk run terminated `complete` with the objection unread and no revised contract. The agreement between writer (generator prompt), receiver (proposer prompt + test), and intent (documentation sequence diagram) — combined with the total absence of an orchestrator dispatcher — makes the root cause unambiguous.
