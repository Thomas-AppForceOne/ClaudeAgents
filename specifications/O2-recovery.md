# O2 — Recovery

> **Status:** prescriptive. The first prescriptive authoring of this spec landed during the post-E1 revision break per the [roadmap](roadmap.md#revision-break--post-e1-audit--o2-first-prescriptive-revision). The earlier descriptive draft is retired; everything below is implementable.

**Decisions baked in (for git-history readers).** The post-E1 revision break enumerated six design choices; this spec was authored against these defaults:

1. `gan-recover` placement: **orchestrator-internal in `skills/gan/SKILL.md`** (no separate agent file).
2. Overlay-drift policy: **warn-and-continue** (drift surfaces in the recovery report; recovery proceeds).
3. Cross-project recovery: **refused** (no `--project-root` override in v1; `progress.json.projectRoot` must match the current resolved root).
4. Greenfield runs: **out of scope for v1** — every run targets an existing repo and records `progress.json.projectRoot` (per Decision 3), so there is no null-target / greenfield run for recovery to guard. (The `targetDir` field an earlier draft named here was never added to the schema and is dropped; `projectRoot` is the real field.)
5. Recovered-run lifecycle: **same `runId`, append `recoveryHistory[]`, flip `terminal: true` on graceful end** (no copy-into-new-run-id step). Concurrent-run lockfile **is** present in v1.0 per Section 8; this revises decision 5's original "no lock file" stance.
6. Garbage collection: **none in v1** (`gan run prune --keep <N>` is a Phase 7+ follow-up).

## Problem

When a `/gan` run aborts (user answered `N` at a resume prompt, budget cap hit, agent
raised a fatal blocking condition, manual stop mid-run), the user has historically had no
way to resume the specific failed run. The legacy mechanism deleted `.gan/` on teardown,
destroying every artefact required to continue — `progress.json`, sprint contracts,
evaluator feedback, generator spec rendering, base-commit SHAs.

Under F1's filesystem layout this premise has changed. Per-run state now lives at
`.gan-state/runs/<run-id>/` (zone 2) and **persists across runs by design**: F1 line 67
defines zone 2 as durable, and the per-run subdirectory under `runs/<run-id>/` is
"archived or deleted on teardown per O2-recovery.md." The orchestrator no longer deletes
run state on graceful exit — it leaves the directory in place. The previous mechanism
(move `.gan/` to a separate archive root, then copy back on recover) is dead architecture.

The user's expectation, unchanged from legacy:

```
/gan --recover              # resume the most recent non-complete run
/gan --recover --run-id X   # resume a specific run
/gan --list-recoverable     # print a table of recoverable runs
```

What changes is how the framework delivers it.

## Solution summary

> **v1.0 scope and status markers (per [D1](D1-diagnostic-clarity.md)).** This spec describes the *full* recovery + cleanup surface; the roadmap ships it in slices. **`[shipped-in-v1.0]`:** `--list-recoverable` (enumeration, §4), the concurrent-run lock (§8), and terminal marking (§3). **`[partial-v1.0]`:** `--recover` (§5) — minimal trace-driven resume in v1.0; the richer UX (overlay-drift warnings, re-attach edge cases) is v1.1. **`[deferred-to-v1.1]`:** `--cleanup` in full (§5.5 — `--all` / `--include-terminal` / `--yes` / merge-aware remote-branch deletion). The v1.0 implementation builds only the `shipped`/`partial` slices; sections below carry these markers. Without this demarcation the v1.0-slice effort (~2–3 sprints; see § "Effort (v1.0 slice)") and D1's marker discipline both fail against the full spec. **Roadmap entry mid-rollout:** O2's slot flips to ✅ when the **v1.0 slice** ships (that is what "shipping O2" means at v1.0); the `[deferred-to-v1.1]` `--cleanup` surface is tracked by the separate v1.1 "full recovery UX" entry and does not hold the slot open. The spec prose is complete and immutable from that flip — only the deferred *implementation* continues.

Three coordinated mechanisms, all post-E1:

1. **Run directories persist as the recovery surface.** No archive copy step. The
   orchestrator marks runs terminal at teardown (writing `terminal: true` plus a
   `terminalReason` to `progress.json`) but never moves or deletes the directory. A
   recoverable run is one whose `progress.json` has `terminal: false` (or is missing
   `terminal` for backwards-compat — see migration below).

2. **Recovery is re-attach + resume, not copy + restore.** `--recover`:
   - Calls `validateAll()` in non-aborting mode (per E1's shipped recovery contract — the
     user must be able to recover a known-broken project). This is **shipped** behaviour
     (`validate.ts`'s non-aborting mode), **not** an O1 dependency — see Dependencies.
   - Reads the target run's `progress.json` directly from `.gan-state/runs/<run-id>/`.
   - Re-attaches the git worktree from the recorded `runBranch`.
   - Compares the archived overlay state in `progress.json.overlaysAtSnapshot` against
     the current `getResolvedConfig().overlays`; surfaces drift as a recovery-report
     warning.
   - Falls through to the existing in-`SKILL.md` resume state machine.

3. **`--list-recoverable` enumerates `.gan-state/runs/*/progress.json`** and filters by
   `terminal: false` (recoverable) or includes terminal entries when the user asks for
   history. Read-only; never mutates state.

The `.gan-state/modules/` subdirectory is **never touched** by recovery — F1's zone-2
ownership invariant. Module state belongs to modules; run-state has its own lane.

> **F8 supersession (module-state relocation).** Per [F8](F8-centralized-module-state-store.md), durable module state no longer lives under `<projectRoot>/.gan-state/modules/`; it moves to a separate, repo-keyed store outside any worktree (`<module-state-root>/<repo-key>/`, default `~/.gan-module-state/`) — a different root from F7's run-data store. The module store is durable cross-run and server-written; only the owning module writes or prunes it. O2's "never touched by recovery" invariant carries over **verbatim** to the new location: `--recover`, `--list-recoverable`, and `--cleanup` never read or write `<module-state-root>/<repo-key>/`, exactly as they never touched `.gan-state/modules/`. Read every `.gan-state/modules/` reference below — the Solution-summary "never touched by recovery" line and the Section 6 Forbidden-territory bullet — as the relocated module store.


## Detailed design


### 1. Run-directory layout (post-E1)

```
.gan-state/runs/<run-id>/
├── progress.json                 # orchestrator-owned; updated throughout run
├── raw-prompt.md                 # verbatim user prompt (E5; written by orchestrator)
├── clarified-spec.md             # E5 clarifier output (planner/proposer input)
├── spec.md                       # planner output
├── sprint-N-contract.json        # contract-proposer output (post-review)
├── sprint-N-contract-draft.json  # contract-proposer output (pre-review)
├── sprint-N-feedback-A.json      # evaluator output for sprint N attempt A
├── sprint-N-objection-A.json     # generator objection (when applicable)
├── sprint-N-base-commit.txt      # base commit SHA for sprint N
├── worktree/                     # the git worktree (lives here, not at <cwd>/.gan/worktree)
├── trace/                        # T1 structured run trace (events + payloads/ + index.json)
└── telemetry/                    # opt-in telemetry capture; honors --no-telemetry
    ├── config.json
    └── outcome.json
```

`<run-id>` follows the `<YYYYMMDDTHHMMSS>-<4 hex>` form already established.

The worktree's parent directory moves from `.gan/worktree/` (legacy) to
`.gan-state/runs/<run-id>/worktree/` (post-E1, per F1 zone 2). Generator confinement
hooks derive their allowed zones from the orchestrator-exported `GAN_WORKTREE` /
`GAN_RUN_DIR` env vars (per F7 / SKILL.md "Confinement"), **not** a hardcoded
`.gan-state/runs/<run-id>/worktree/` path — in case 1a `GAN_WORKTREE` is the
engineer's own worktree, not a run-scoped directory.

> **F7 supersession (run-data relocation).** Per [F7](F7-central-run-data-store-and-worktree-execution.md), the run *data* shown above — `progress.json`, `spec.md`, the `sprint-*` artifacts, `trace/`, and `telemetry/` — no longer lives under `<projectRoot>/.gan-state/runs/<run-id>/`. It lives in the central, repo-keyed store at `<store-root>/<repo-key>/runs/<run-id>/` (default `~/.gan-runs-data`), so it survives removal of the worktree it ran in. Only the `worktree/` subtree stays at `<project>/.gan-state/runs/<run-id>/worktree/` (gan-created, cases 1b/1c) or is the engineer's own worktree (case 1a). Read every `.gan-state/runs/<run-id>/` *data* path below as the central run dir; read `<projectRoot>` as the **main-worktree root** (the parent of `git rev-parse --git-common-dir`), which makes run *discovery* (`--list-recoverable`, `--cleanup`) and the lock **repo-wide** across all worktrees of the repo; and read `run.lock` as `<store-root>/<repo-key>/run.lock`. **`--recover` is the exception:** resuming a run is bound to its recorded `workspace.worktreePath` and refuses from any other worktree (per F7 — a run resumes only in the worktree it executed in). O2's full implementation (later in the v1.0 order) applies this uniformly.

### 2. `progress.json` extensions for recovery

The post-E1 `progress.json` schema gains the recovery fields below beyond the legacy set. The legacy set itself **includes `workspace`** — `{worktreePath, branch, createdByGan}`, written today by F7's shipped `recordWorkspace` and read by recovery (§5) and cleanup (§5.5); because O2 authors the strict `progress-v1.json`, the schema **must** list it or every run that recorded a workspace fails validation:

```json
{
  "runId": "20260503T143010-b8e1",
  "status": "clarifying | planning | negotiating | building | evaluating | complete | failed",
  "currentSprint": 3,
  "currentAttempt": 1,
  "contractRevision": 0,
  "totalSprints": 7,
  "completedSprints": 2,

  "projectRoot": "/Users/thak/projects/myapp",
  "runBranch": "gan/20260503T143010-b8e1",
  "baseBranch": "develop",
  "startingBranch": "develop",

  "workspace": {
    "worktreePath": "/Users/thak/projects/myapp/.gan-state/runs/20260503T143010-b8e1/worktree",
    "branch": "gan/20260503T143010-b8e1",
    "createdByGan": true
  },

  "terminal": false,
  "terminalReason": null,
  "terminalAt": null,

  "overlaysAtSnapshot": {
    "user":    {"loaded": true, "path": "~/.claude/gan/user.md", "hash": "sha256:..."},
    "project": {"loaded": true, "path": ".claude/gan/project.md", "hash": "sha256:..."}
  },

  "recoveryHistory": [
    {"recoveredAt": "2026-05-03T14:55:00Z", "fromStatus": "building", "atSprint": 2}
  ]
}
```

- `projectRoot` — recorded at run start; used by `--recover` to confirm the recovery
  is happening in the right place.
- `terminal` / `terminalReason` / `terminalAt` — set when the run ends. `terminal:
  false` (or missing) means recoverable. `terminalReason` is one of the enumerated
  codes below.
- `overlaysAtSnapshot` — sha256 of overlay file contents at snapshot time. Compared
  against current state during recovery to detect drift.
- `recoveryHistory[]` — appended on each `--recover` invocation. Empty array on a
  fresh run.
- `workspace` — `{worktreePath, branch, createdByGan}`; a **legacy** field (written
  today by F7's `recordWorkspace`, not new this sprint), listed here because the
  strict schema must accept it. Recovery re-attaches the run to
  `workspace.worktreePath` (§5) and cleanup classifies teardown by
  `workspace.createdByGan` (§5.5).

Enumerated `terminalReason` codes:

```
complete                       Run finished all sprints successfully
failed-max-attempts            Sprint exhausted maxAttempts
failed-budget                  Hit maxAttemptsTotal or maxMinutes
failed-loop-detected           A1 halt — see safetyHalt event for discriminator
failed-evaluation-rejected     E8 renegotiation cap hit with unresolved blocker
                               findings — the gate REJECTED the work. A real
                               evaluation failure, distinct from the user-initiated
                               aborted-* codes and from aborted-contract-failed
                               (which is a pre-generation negotiation failure)
failed-clarifier-error         E5 clarifier itself errored (e.g. LLM call failed)
aborted-by-user                User answered N at resume prompt OR typed [c]ancel
                               at the E5 draft preview action menu
aborted-planner-error          Planner failed (schema, refusal, etc.)
aborted-contract-failed        INITIAL contract negotiation hit max revisions
                               (before any generator work; cf. failed-evaluation-
                               rejected, the post-generation gate rejection)
aborted-validation-failed      validateAll() failed in aborting mode (taxonomy only — see note)
```

**`aborted-validation-failed` is taxonomy-only, never a written `progress.json` value:** an aborting-mode `validateAll()` failure halts at SKILL.md step 3 — *before* `resolveRunStore`/`acquireRunLock`/run-dir creation (R7 places the lock + first zone-2 write at step 7) — so there is no `progress.json` to carry it. It documents the abort taxonomy for completeness; the strict schema permits it but no run records it. `failed-loop-detected` is written by all three A1 halt reasons (`roleCeilingExceeded`, `sprintBudgetExceeded`, `editOscillation`); the specific reason lives in the corresponding `safetyHalt` trace event's payload, not in `progress.json`. **Note the two distinct "budget" concepts** (they never share a code): A1's `sprintBudgetExceeded` is the per-sprint *attempt* ceiling — a loop-detection halt, so it writes `failed-loop-detected`; `failed-budget` is the run-wide *resource* cap (`maxAttemptsTotal` / `maxMinutes`), a non-loop ceiling. Both render as a halted, recoverable run, but the path that writes each is unambiguous. E5's draft preview auto-approves on timeout (not a halt), so there is no terminal code for "user did not respond." Explicit user `[c]ancel` at the action menu maps to `aborted-by-user`.

Schema lives at `schemas/progress-v1.json` (flat in `schemas/`, consistent with the rest of the schema set and PROJECT_CONTEXT's naming — **not** a `run-state/` subdirectory; the earlier `schemas/run-state/` path was stale); this sprint adds it to the schema set if it isn't already present. **It must include the fields E8 (which ships before O2) writes** — the `failed-evaluation-rejected` `terminalReason` value above and the `contractRevision` field — so an E8-renegotiated run validates against this schema; see Dependencies. **`additionalProperties` posture (the orchestrator writes `progress.json` free-form, so this is load-bearing):** the strict schema MUST enumerate **every** field the orchestrator writes — `runId`, `status`, `currentSprint`/`currentAttempt`, `totalSprints`/`completedSprints`, `contractRevision`, `projectRoot`, `runBranch`/`baseBranch`/`startingBranch`, `workspace`, `terminal`/`terminalReason`/`terminalAt`, `overlaysAtSnapshot`, `recoveryHistory` — and set `additionalProperties: false`. (This list is the schema's load-bearing `additionalProperties: false` reconciliation set, **not** a parallel doc-inventory table — the schema file is its single home; the AC below gates them in lockstep.) An AC **reconciles** that enumerated set against the orchestrator's actual writes — and it is a **hard merge gate, not advisory**: the reconciliation fixture is a `progress.json` **committed to the repo, captured from an E8 dogfood run** (E8 ships before O2, so such a run exists) — so it provably carries `contractRevision` and the `failed-evaluation-rejected` `terminalReason` E8 writes, and is real captured output, not a hand-written mock. CI validates the **committed file** against the schema (no LLM needed at CI time — the capture happened once, at authoring), and the O2 PR does **not** merge until it validates clean. A field the orchestrator writes but the schema omits therefore fails **CI**, never a live run. This is exactly the **F5/R6 lag class** — a strict validator landing *after* the writers it validates and silently drifting from them — closed here by gating on real captured output rather than a hand-written fixture; get it wrong and the strict schema rejects every real run.

### 3. Teardown — terminal marker, never delete

Replace every legacy `rm -rf .gan` (and equivalent worktree-teardown deletion) with:

1. Write the worktree branch's tip (the run's accumulated commits stay on the run
   branch in git; this is unchanged).
2. `git worktree remove .gan-state/runs/<run-id>/worktree --force`. This detaches the
   worktree but leaves the directory tree in place.
3. Update `progress.json`:
   - `terminal: true`
   - `terminalReason: <one of the enumerated codes>`
   - `terminalAt: <ISO 8601 UTC timestamp>`
4. The directory remains on disk; subsequent `--list-recoverable` will see it as
   terminal.

Failure modes:

- **Worktree remove fails** (filesystem issue, branch checked out elsewhere) → log a
  warning; still write the terminal marker so the run isn't picked up as recoverable.
  Document in the recovery report that the worktree may need manual cleanup.
- **`progress.json` write fails** (disk full, permissions) → loud stderr error; the run
  remains "recoverable" (because `terminal: false` or missing) which is the safer
  failure mode.

### 4. `--list-recoverable` `[shipped-in-v1.0]`

Flag handler shipped by F7 (in the SKILL.md flag table); O2 specifies its behaviour. Behaviour:

1. Calls `validateAll()` in non-aborting mode (per E1's recovery contract).
2. Enumerates `<store-root>/<repo-key>/runs/*/progress.json` (per F7 — formerly
   `<projectRoot>/.gan-state/runs/`). Because the `<repo-key>` is derived from the repo's
   main-worktree root, this enumeration is **repo-wide**: every run of the repo is listed
   from any of its worktrees. Enumeration is discovery, not resume — it never binds to a
   worktree.
3. By default: filters to `terminal: false` (or missing). With `--include-terminal`,
   also lists terminal runs.
4. Sorts descending by directory mtime (the most recently active run first).
5. Prints a table:

   ```
   RUN ID                    STATE      SPRINT  STARTED AT            REASON                  RECOVERABLE
   20260503T143010-b8e1      building   3/7     2026-05-03T14:30:10Z  -                       yes
   20260502T210000-a9f2      failed     5/7     2026-05-02T21:00:00Z  failed-max-attempts     no (terminal)
   20260501T120000-aaaa      complete   7/7     2026-05-01T12:00:00Z  complete                no (terminal)
   ```

6. Exit 0. No state mutation, no spawn.

If no runs found: `No runs found at <store-root>/<repo-key>/runs/.` Exit 0.

### 5. `--recover [--run-id X]` `[partial-v1.0]`

Flag handler shipped by F7 (in the SKILL.md flag table); O2 adds the status-keyed resume dispatch it falls through to (§5 step 7). Per E1's recovery contract,
runs `validateAll()` in non-aborting mode first.

1. **Resolve target run.** (Enumerate `<store-root>/<repo-key>/runs/` per F7 — repo-wide.)
   - If `--run-id X`: look up `<store-root>/<repo-key>/runs/X/progress.json`. Missing
     → `Run <X> not found at <store-root>/<repo-key>/runs/X/.` Exit 1.
   - Otherwise: enumerate runs, filter `terminal: false`, sort by mtime desc, pick the
     first. None → `No recoverable runs found at <store-root>/<repo-key>/runs/.`
     Exit 1.

2. **Preflight.**
   - Read `progress.json` from the run directory.
   - **Project-root check**: if `progress.json.projectRoot` exists and
     differs from the orchestrator's resolved current project root, refuse:
     `Run <runId> was created at <oldRoot>; cannot recover from <currentRoot>. Cross-
     project recovery is not supported.` Per F7, `projectRoot` is the **main-worktree
     root** (the parent of `git rev-parse --git-common-dir`), so the comparison is
     repo-wide across worktrees, not toplevel-specific. Exit 1.
   - **Worktree-anchor check (per F7)**: a run is *resumable only in the worktree it
     executed in*. Read `progress.json.workspace.worktreePath`; if the current invocation
     is not that worktree, refuse: `Run <runId> was executed in worktree <path> (branch
     <branch>); recover it from there.` If the recorded worktree no longer exists, refuse
     with the same path plus guidance to recreate it. The comparison is canonical (F1
     determinism pins), so a trailing-slash or case-only difference is not a spurious
     refusal. The same run is still *listed* by `--list-recoverable` from any worktree.
     Exit 1.
   - **Run-branch check**: `git rev-parse --verify <runBranch>` — if missing,
     `Run branch <runBranch> is not present in this repository. The run state survives
     at <path> but cannot be resumed.` Exit 1.
   - **Working-tree-clean check**: same as the orchestrator's normal pre-run check.
     Refuse if dirty.
   - **Validation check**: if `validateAll()` returned errors, surface the structured
     error report alongside this preflight; recovery still proceeds (per E1's
     non-aborting contract) but the user sees the configuration is broken before
     downstream agents fire on it.

3. **Overlay-drift check**.
   - Compute current overlay hashes (project + user).
   - Compare against `progress.json.overlaysAtSnapshot.{project,user}.hash`.
   - For each mismatch, emit a recovery-report warning naming the overlay tier and the
     hash change (no diff).
   - Resume continues regardless.

4. **Re-attach the worktree.** The worktree path is `progress.json.workspace.worktreePath`
   (the run's recorded, recovery-anchored worktree — under `<project>/.gan-state/runs/<id>/worktree/`
   for a gan-created workspace, or the engineer's own worktree in case 1a). The run *data*
   itself lives in the central store, not the worktree.
   - `git worktree add <workspace.worktreePath> <runBranch>` (no `-b` — the branch exists).
   - If the worktree is already registered (`git worktree list` shows it), skip the add.
   - If `git worktree add` fails because the path is registered but pointing elsewhere,
     `git worktree prune` then retry once.

5. **Append `recoveryHistory[]`.**
   ```json
   {
     "recoveredAt": "<ISO 8601 UTC>",
     "fromStatus": "<progress.json.status at recovery time>",
     "atSprint": "<currentSprint>"
   }
   ```
   Write `progress.json` atomically.

6. **Print recovery report.**
   ```
   Recovered run 20260503T143010-b8e1
     Status:     building
     Sprint:     3 of 7 (attempt 1)
     Run branch: gan/20260503T143010-b8e1
     Overlays:   project drifted (sha256 changed since archive)
   Resuming from sprint 3 attempt 1.
   ```

7. **Resume via the status-keyed dispatch O2 *authors* in `SKILL.md`.** This dispatch does **not** exist today — shipped `SKILL.md`'s "Regular invocation flow" is strictly forward (validate → clarify → worktree → forward sprint loop), with no logic that reads `progress.json.status` and re-enters at the matching point. **O2's PR adds that resume-by-`status` dispatch** (the load-bearing mechanism of `--recover`): it reads `progress.json.status` ∈ `clarifying`/`planning`/`negotiating`/`building`/`evaluating` and re-enters the loop at the corresponding stage (for `building`, reset the worktree to the recorded `sprint-N-base-commit.txt` and respawn the generator; gapless trace resume per T1). E8's `negotiating` resume (E8 § "Bounding thrash") rides this same dispatch. Specifically:
   - `clarifying` resume: the orchestrator reads the most recent `clarified-spec.md`
     (and any `clarified-spec.md.round-N` from the round counter on disk), re-presents
     the draft preview with the action menu, and the user picks up where they left off.
     Round count is preserved across recovery — a halt mid-round-2 resumes at round-2,
     not round-1.

### 5.5. `--cleanup [--run-id X] [--all] [--include-terminal] [--yes]` `[deferred-to-v1.1]`

The **full** `--cleanup` surface (lands in v1.1). **Why a stub and not "ship what F7 already built":** F7 shipped the *tested* `src/config-server/storage/cleanup-planner.ts` (`planRunCleanup`/`executeRunCleanup`/`checkActiveRunGuard`/`isBranchMerged`, with a real-git test suite), but it is **import-only** — re-exported from `src/index.ts` with **no CLI or MCP-tool caller**, so the markdown orchestrator cannot invoke it (the same shipped-but-uncallable class R7 wires for the trace/safety/run-store libraries). The `SKILL.md` `--cleanup` prose describes the destructive steps as if operative, but it is markdown-Bash and **behaviour-unverified** (CI has no LLM). v1.0 therefore deliberately **stubs** rather than ships an unverified *destructive* operation: shipping a behaviour-unverified `rm -rf`/branch-delete is the one place "mechanism-present, behaviour-unverified" is unacceptable. The **v1.1 deliverable is to wire the already-tested `cleanup-planner.ts` as a deterministic tool/CLI** (turning the uncallable tested code into the operative path) — F7's work is consumed, not discarded. This is not a net-new flag; it is an existing over-promise scaled back to an honest stub until its tested backing is callable. Parsed at the SKILL.md flag-table dispatch; symmetric to `--recover` in resolution semantics, but **destructive** — it removes the resolved run(s) from disk rather than resuming them.

**v1.0 behaviour — deferred stub.** Because `--cleanup` is `[deferred-to-v1.1]`, its v1.0 SKILL.md dispatch handler does **not** run the destructive logic below: per D1's deferred-marker discipline it prints the structured "this command requires v1.1" message and exits non-zero — it never no-ops and never partially cleans. Everything specified below is the v1.1 implementation; the v1.0 dispatch is the stub.

Per E1's recovery contract, runs `validateAll()` in non-aborting mode first. Does **not** acquire the run lock (it operates on non-active runs; an attempt to clean up an active run is refused per the active-run check below).

1. **Resolve target run(s).** Mirrors `--recover`; enumeration is `<store-root>/<repo-key>/runs/` (per F7 — repo-wide).
   - `--run-id X`: target a single run by id. Missing → `Run <X> not found at <store-root>/<repo-key>/runs/X/.` Exit 1.
   - `--all`: target every non-terminal run.
   - `--all --include-terminal`: target every run regardless of terminal flag.
   - Default (no `--run-id` and no `--all`): the most recent non-terminal run (same selection as `--recover`). None found → `No non-terminal runs found at <store-root>/<repo-key>/runs/.` Exit 0 (not an error — nothing to do).

2. **Active-run guard.** For each resolved target:
   - If `<store-root>/<repo-key>/run.lock` exists (per F7 — formerly `<projectRoot>/.gan-state/run.lock`), parse it for `runId` + `pid`.
   - If `runId` matches a target AND `pid` is still alive (`kill -0 <pid>`): refuse — `Cannot clean up <runId>; it is currently active (pid <pid>). Stop the run first.` Exit 1.
   - Stale locks (dead pid) are ignored; the target run is included.

3. **Preview + confirmation.**
   - Print a table of what will be deleted:
     ```
     RUN ID                    STATE      SPRINT  STARTED AT            SIZE
     20260503T143010-b8e1      building   3/7     2026-05-03T14:30:10Z  42 MB
     20260502T210000-a9f2      failed     5/7     2026-05-02T21:00:00Z  17 MB
     Total: 2 runs, 59 MB
     ```
   - Prompt `Delete these runs? [y/N] ` and read one line from stdin.
   - On `y` / `Y`: proceed. On anything else (including `<empty>`): abort with exit 0.
   - `--yes` bypasses the prompt (still prints the table for the audit trail).
   - On non-TTY stdin without `--yes`: refuse — `Refusing to delete <N> runs without confirmation. Pass --yes to bypass the prompt.` Exit 1.

4. **Per-run cleanup.** For each confirmed target. Per F7, cleanup is **merge-aware** and classifies the workspace by `progress.json.workspace.createdByGan`:
   - **gan-created workspace (cases 1b/1c, `createdByGan: true`):**
     - `git worktree remove <workspace.worktreePath> --force` (silent if not registered).
     - Determine the run branch's merge status **before any deletion**: `git merge-base --is-ancestor <branch> <base>` (exit 0 = merged) and/or `git branch --merged <base>` membership, with `<base>` from the recorded `baseBranch`, else the resolved default branch (`origin/HEAD` → `init.defaultBranch` → `develop`/`main`/`master`), and the branch's `@{upstream}` consulted when set.
       - **Merged** → `git branch -D <branch>` locally, and `git push <remote> --delete <branch>` on the remote when a tracking branch exists.
       - **Not merged** → warn (naming the branch) and do **not** delete it without confirmation or `--yes`.
   - **user-owned workspace (case 1a, `createdByGan: false`):** never touch the worktree or branch.
   - **Always** (every confirmed target, independent of workspace type or merge status): `rm -rf <store-root>/<repo-key>/runs/<runId>` (the central-store run directory — the source-of-truth artefact; formerly `<projectRoot>/.gan-state/runs/<runId>`).
   - `git worktree prune` (runs once at the end of the batch, not per-run).
   - On any step failing: log a per-run warning naming the step and the run, continue with the next run. The central-store `rm` is the only step whose failure escalates to exit 1 for the whole batch.

5. **Final report.**
   ```
   Cleaned up 2 runs. Freed 59 MB.
   ```
   If any per-run warnings fired, summarise: `1 run had teardown warnings; see above.`

**Run-branch policy.** O2's recovery design leaves run branches in git "for inspection" after terminal teardown. `--cleanup` explicitly removes them — the user's expectation when invoking cleanup is full reclamation, not partial archive.

### 6. Forbidden territory

`--recover`, `--list-recoverable`, and `--cleanup` are forbidden from:

- Reading or writing the durable module store (per F1 zone-2 invariant). Per the F8 supersession note above, that store is the relocated, repo-keyed `<module-state-root>/<repo-key>/` (default `~/.gan-module-state/`), no longer `<projectRoot>/.gan-state/modules/`; recovery and cleanup touch neither the relocated store nor any residual project-local `.gan-state/modules/`.
- Reading or writing `.claude/gan/` (configuration belongs to the user; recovery is
  read-through-the-snapshot only).
- Reading or writing `.gan-cache/` (regenerable; not run-state).

Concretely: any code path under recovery that opens a file outside
`.gan-state/runs/<run-id>/` (or `.gan-state/runs/` for enumeration) is a bug. A test
asserts this against `tests/fixtures/stacks/<fixture>/.gan-state/modules/<dummy>/`
content remaining byte-identical across recovery.

### 7. Edge cases

| Case | Behavior |
|---|---|
| Run branch force-deleted | Refuse in preflight; `--list-recoverable` still shows the run. |
| Two `--recover` invocations against the same run, concurrently | Both contend on the §8 `link(2)` run-lock, acquired before any zone-2 work; the second fails closed at lock acquisition. No separate heuristic is needed — the real lock already serializes concurrent recovers (the earlier 5-minute `recoveryHistory` heuristic is retired as a pre-§8-lock leftover). |
| Recovered run completes successfully | `terminal: true` flips. The run is no longer `--list-recoverable`-recoverable. |
| Recovered run's recovery itself fails | New `recoveryHistory[]` entry records the failure. The run remains `terminal: false`; future `--recover` is not blocked. |
| Overlay drift but only formatting whitespace | Hashes still differ. Warning still fires. Acceptable false-positive; the user can ignore. |
| Project moved on disk (`projectRoot` recorded vs current cwd diverge) | Refuse per Decision 3A. Future `--project-root` flag could relax. |
| Stale `.gan/` directory at cwd from pre-E1 era | Hard error per F1's "no migration path" rule. User deletes manually. |

### 8. Concurrent-run lockfile (v1.0)

**Decision: hard refuse on concurrent invocations against the same project root.**

A user running `/gan` in two terminals against the same project would, without a lock, produce racing run-ids both writing to overlapping zone-2 paths (per-run state dirs are unique, but module state, run-branch creation, and the worktree git operations are shared resources). v1.0 needs a deterministic failure mode rather than silent race-condition corruption.

Mechanism:

- On `/gan` invocation (any short-circuit-or-not path), the orchestrator acquires an exclusive lock at `<store-root>/<repo-key>/run.lock` (per F7; formerly `<projectRoot>/.gan-state/run.lock`) via the framework's existing portable **`link(2)` run-lock** — the shipped `src/config-server/storage/run-lock.ts`, exposed to the orchestrator through an R7 lock-acquire/release tool — **not** `flock(2)`. (`flock` has no `flock(1)` CLI on macOS, the v1 target and release-gating platform, and the markdown orchestrator cannot issue the syscall; the shipped lock already uses atomic `link(2)`, which is portable and orchestrator-callable via R7.) The lock is acquired before any other zone-2 work. Because the key is the repo's main worktree, this serializes runs **repo-wide** — concurrent `/gan` from two worktrees of the same repo contend on the one lock.
- Lock contents: `{ runId, pid, startedAt, hostname }` written atomically (temp + rename) on acquisition.
- On failure to acquire (lock held by another process):
  - Read the lock contents.
  - Verify the holding process is still alive (`kill -0 <pid>` on POSIX, equivalent on Windows).
  - **If holder alive:** the shipped `link(2)` lock throws `InvariantViolation` with `reason: ConcurrentRunInProgress` (per `run-lock.ts`), which the CLI maps to **exit 4** (`EXIT_INVARIANT_VIOLATION`, not exit 1); the message names the holder's `runId`, `pid`, `startedAt`, and the suggestion: "Wait for the other run to finish, or `kill <pid>` if it is stuck."
  - **If holder dead** (stale lock from a hard-killed previous run): break the lock, log a warning to stderr, acquire fresh, proceed.
  - **Recovery exception — the stranded-self-lock case (the deadlock, and why it is *not* auto-broken).** Because the lock records the holder's `pid`, and in the MCP-tool context that pid is the **long-lived config server** (per R7's lock-lifecycle note), a run that aborted *without* releasing — the exit-release below didn't run (SIGKILL, or the markdown orchestrator skipped the step) — can leave a lock whose pid is **still alive** (the server outlived the run). The *alive-holder* branch then refuses `--recover` even though the run is dead. **The tempting fix — auto-break when the lock's `runId` matches the run being recovered — is unsafe and is rejected here:** a live-pid lock with a matching `runId` is *ambiguous*, because the shared server pid cannot distinguish an **interrupted** run from one that is **actively executing in another session** which explicitly `--recover`ed the same id; auto-breaking the latter reintroduces exactly the concurrent-corruption this lock exists to prevent (and contradicts the "no bypass flag, manual `rm` is the deliberate friction" stance below). So `--recover` instead **refuses with stranded-self-lock-specific guidance**, distinct from the generic concurrent-run message: it names the holder's `runId`/`pid` and the **exact lock path**, states that the lock is *the same run you are recovering* held under a live server pid — *either* an active session *or* an interrupted run whose lock was never released — and instructs: **if no `/gan` session is running this run, the lock is stale; clear it with `rm <lockpath>` and retry.** That is the same deliberate-friction escape §8 already documents, but now **recognised and explained at the recover path** rather than surfaced as a cryptic `ConcurrentRunInProgress` that looks like a *different*-run conflict. (Safe auto-resume of a same-session stranded lock could be a v1.1 refinement *iff* a per-run liveness signal is added — but the 5-minute `recoveryHistory` heuristic that might have provided it is retired, so v1.0 stays with guided manual clearance.)
- On orchestrator exit (success, halt, error, signal): release the lock by deleting the file.
- The `--print-config`, `--list-recoverable`, and `--help` short-circuits do NOT acquire the lock — they are read-only and don't write zone 2. Only `--recover` and a regular `/gan` invocation acquire it.

Lock semantics are best-effort cross-platform: atomic `link(2)` works on local filesystems but has known weaknesses on some network filesystems. NFS-mounted project roots will see degraded lock semantics; documented limitation. O2 introduces no new lock mechanism — it reuses the shipped `link(2)` run-lock, which already provides exactly this primitive (and is what the active-run guard in §5.5 reads).

A `--no-run-lock` flag is **not** offered in v1.0. The lock is mandatory; bypassing it requires deleting the lock file by hand (`rm <store-root>/<repo-key>/run.lock`, per F7 — formerly `<projectRoot>/.gan-state/run.lock`), which is a deliberate friction. This is the exact `rm <lockpath>` the stranded-self-lock guidance above points to.

### 9. Out of scope (v1)

- Cross-machine recovery.
- Cross-project recovery (`--project-root` override).
- Greenfield-run recovery.
- Garbage collection.
- Recovery via the CLI (`gan recover`); only `/gan --recover` in v1. The CLI
  command is a Phase 7 candidate.
- Cleanup via the CLI (`gan cleanup`); only `/gan --cleanup` in v1. The CLI
  command is a Phase 7 candidate, paired with the `gan run prune --keep <N>`
  garbage-collection follow-up.

---

## Acceptance criteria

Each criterion concrete and testable.

> **Path note (post-F7).** ACs below use the `.gan-state/runs/<run-id>/` shorthand for *run data*; per the F7 supersession note above, run data lives in the central store, so read every run-*data* path as `<store-root>/<repo-key>/runs/<run-id>/` (only the `worktree/` subtree stays under `.gan-state/runs/`). The ACs that previously spelled out `<projectRoot>/.gan-state/runs/` are corrected to the central-store form so an implementer coding to an AC cannot build the pre-F7 path.

1. **Terminal marker on graceful run end.** A run that completes all sprints lands
   `progress.json.terminal: true`, `terminalReason: complete`, `terminalAt`
   populated, run directory still on disk.

2. **Terminal marker on max-attempts failure.** Same fields; `terminalReason:
   failed-max-attempts`.

3. **Terminal marker on user-N abort.** Same; `terminalReason: aborted-by-user`.

4. **`--list-recoverable` empty case.** Project with no `.gan-state/runs/` (or empty)
   prints "No runs found..." and exits 0.

5. **`--list-recoverable` filters terminal.** Three runs (one terminal-complete, one
   terminal-failed, one non-terminal) → default output shows only the non-terminal one;
   `--include-terminal` shows all three sorted by mtime.

6. **`--recover` without `--run-id` picks most recent recoverable.** Two non-terminal
   runs → newer mtime wins.

7. **`--recover --run-id X` for missing run.** Exit 1, message names the run's central-store path `<store-root>/<repo-key>/runs/X/`.

8. **`--recover` refuses cross-project recovery.** A run with `projectRoot:
   /old/path` invoked from a different `cwd` → exit 1, message names both paths.

9. **`--recover` refuses missing run branch.** Run branch deleted via `git branch -D`;
   `--recover` exits 1 with the documented message.

10. **`--recover` refuses dirty working tree.** Same dirty-tree message as the
    orchestrator's normal preflight.

11. **`--recover` runs `validateAll()` non-aborting.** A project with broken
    overlays + a recoverable run → recovery proceeds; the recovery report includes the
    structured error block.

12. **Overlay drift surfaced.** Recover after editing `.claude/gan/project.md` →
    recovery report's "Overlays:" line names "project drifted".

13. **Worktree re-attach.** After `--recover`, `git worktree list` includes the
    run's worktree at `.gan-state/runs/<runId>/worktree` checked out to `<runBranch>`.

14. **`recoveryHistory[]` appended.** After `--recover`, `progress.json.recoveryHistory`
    has one entry with `recoveredAt`, `fromStatus`, `atSprint`.

15. **`.gan-state/modules/` untouched.** A regression test seeds
    `tests/fixtures/<fixture>/.gan-state/modules/dummy/state.json` with a fixed payload,
    runs the entire `--list-recoverable` + `--recover` flow, and asserts the file is
    byte-identical at the end.

16. **Resume state machine takes over.** After successful `--recover` on a
    `building/sprint 3/attempt 1` run, the next thing the orchestrator does is reset the
    worktree to the commit recorded in `sprint-3-base-commit.txt` (a run-*data* artifact read
    from the **central store** `GAN_RUN_DIR`, not the worktree) and respawn the generator for
    attempt 1 (via the `building` resume branch O2 authors in SKILL.md — AC verifies the dispatch
    exists). No duplicate counting, no branch corruption.

17. **Migration: stale `.gan/` directory hard error.** Per F1 acceptance criteria — a
    project with a pre-existing `.gan/` halts with a hard error instructing manual
    deletion. `--recover` and `--list-recoverable` honor this rule.

18. **`--cleanup --run-id X` removes a single run.** After cleanup,
    `.gan-state/runs/X/` is gone, `git branch -l 'gan/X*'` is empty (the run branch is `gan/<run-id>`, per the `runBranch` field — not a `gan/run/` scheme), and
    `git worktree list` does not include the run's worktree path.

19. **`--cleanup` (no flags) targets most recent non-terminal run.** Two non-terminal
    runs; older one stays on disk, newer one is removed.

20. **`--cleanup --all` removes every non-terminal run.** Three runs (1 non-terminal,
    1 terminal-complete, 1 terminal-failed) → only the non-terminal one is removed; the
    two terminal ones remain.

21. **`--cleanup --all --include-terminal` removes everything.** Same three-run
    fixture → `.gan-state/runs/` is empty afterwards.

22. **`--cleanup` refuses an active run.** A live `run.lock` whose `pid` is alive and
    whose `runId` matches a target → exit 1 with `Cannot clean up <runId>; it is
    currently active (pid <pid>).` Nothing on disk changes.

23. **`--cleanup` ignores stale lock.** `run.lock` referencing a dead pid → cleanup
    proceeds, lock file is deleted as part of the rm of `.gan-state/runs/<runId>/`.

24. **`--cleanup` confirmation gate.** Non-TTY stdin without `--yes` → exit 1, refuses
    to delete; the preview table is still printed for audit.

25. **`--cleanup --yes` bypasses the prompt.** Same fixture as 18; with `--yes`, no
    prompt is shown but the preview table is still printed.

26. **`--cleanup` of a non-existent `--run-id`.** Exit 1, message names
    `<store-root>/<repo-key>/runs/X/`.

27. **`--cleanup` empty case.** Project with no runs → `No non-terminal runs found at
    <store-root>/<repo-key>/runs/.` Exit 0 (not an error — nothing to do).

28. **`--cleanup` is read-only against `.gan-state/modules/`.** Regression test seeds
    `tests/fixtures/<fixture>/.gan-state/modules/dummy/state.json` and asserts the file
    is byte-identical after `--cleanup --all --include-terminal`.

29. **Recover an E8-renegotiated run (the E8↔O2 seam).** A run halted with
    `terminalReason: failed-evaluation-rejected` and `contractRevision > 0` is listed by
    `--list-recoverable` and resumed by `--recover`: recovery reads the active
    `contractRevision` from `progress.json`, re-attaches the canonical
    `sprint-{N}-contract.json` (latest locked revision), and continues. It fails if
    `progress-v1.json` rejects E8's `terminalReason` value or `contractRevision` field.
    **It also asserts revision-scoped budget survives recovery (the half the earlier AC
    omitted):** a recovered run at `contractRevision: 1` whose revision-0 `agentAttempt`
    events would, summed whole-trace, exceed the sprint budget must **not** mis-fire
    `sprintBudgetExceeded` — `reconstructRevisionState(traceRoot, 1)` (E8 § "Bounding
    thrash") tallies only revision-1 attempts, so the budget check sees the scoped count.
    Verifies the budget *scoping* survives recovery, not just that the schema accepts the
    fields.
30. **Concurrent run is refused (orchestrator wiring of §8, not just the unit-tested primitive).**
    With one run holding `<store-root>/<repo-key>/run.lock` (a live `pid`), a second `/gan`
    against the same repo is refused **before any zone-2 write**: `InvariantViolation` /
    `reason: ConcurrentRunInProgress` naming the holder's `runId` / `pid` / `startedAt`, exit 4
    (`EXIT_INVARIANT_VIOLATION`). A lock referencing a dead pid is broken and re-acquired (the
    stale-lock path). Guards the `[shipped-in-v1.0]` §8 lock — `run-lock.ts` is unit-tested, but
    this is the missing AC that the orchestrator actually acquires it on every `/gan`.
    **And the stranded-self-lock case (G3):** a `--recover` against a **live-pid** lock whose
    `runId` **matches** the recovery target refuses with **stranded-self-lock-specific guidance** —
    naming the exact lock path and the `rm` escape, a message distinct from the generic
    different-run `ConcurrentRunInProgress` — and does **not** auto-break (which could clobber a
    same-id run actively executing in another session). The test asserts three branches: the
    stranded-self-lock guidance message (names the path) for a matching-`runId` live-pid lock, the
    generic concurrent-run refusal for a *different*-`runId` live-pid lock, and the silent
    stale-break only for a **dead**-pid lock.
31. **`--cleanup` v1.0 stub is inert and non-destructive (CI-runnable).** Invoking `--cleanup`
    (with any modifier) in v1.0 prints the structured `[deferred-to-v1.1]` "this command requires
    v1.1" message, exits **non-zero**, and **mutates nothing on disk** — no central-store run dir
    removed, no worktree/branch touched, no `git` write. A regression test asserts a seeded
    `<store-root>/<repo-key>/runs/` tree and any gan-created worktree are byte-identical after
    `--cleanup --all --include-terminal --yes`. (Guards M2: the one `--cleanup` behaviour v1.0
    actually ships is the stub, so it must be tested; the destructive ACs 18–28 are the v1.1
    `cleanup-planner`-wiring implementation.)

Tests cover at minimum, **scoped to what ships** (per the `[…]` status markers above):

- **v1.0** (`--list-recoverable`, `--recover`, terminal marking, the lock, the E8 seam, and the `--cleanup` stub): success path for 1-6, 11-16, 29, 30, 31; failure path for 7-10, 17. **CI-runnable vs dogfood-only:** terminal-marking / enumeration / lock-refusal / `--cleanup`-stub and the strict `progress-v1` schema-reconciliation ACs (1-6, 30, 31, §2) run in CI; the resume ACs that need the live orchestrator/LLM loop — **11** (validateAll-during-recovery report), **12** (overlay-drift surfaced), **16** (resume → base-commit reset + respawn), **29** (recover an E8-renegotiated run) — are **dogfood-only** (CI has no LLM), verified at the release-gate dogfood. The §2 reconciliation is a hard CI merge gate.
- **Deferred to v1.1** (the full `--cleanup` surface, §5.5): success path for 18-21, 23, 25, 27; failure path for 22, 24, 26, 28. These ACs are authored here but their tests land with the v1.1 `--cleanup` implementation — the v1.0 PR does **not** gate on ACs 18-28, matching the v1.0-slice effort below (~2–3 sprints).

---

## Effort (v1.0 slice)

**~2–3 sprints** for the v1.0 slice — bumped from an earlier "~1–2 sprints", which undersold it. The slice is more than a thin resume: it authors the strict `progress-v1.json` (`additionalProperties: false`) **and** its hard reconciliation merge-gate against a captured E8-renegotiated run, wires `--list-recoverable` + minimal `--recover` + terminal marking, and lands the E8↔O2 seam (AC 29) and the concurrent-run lock AC (AC 30, whose acquire/release is mostly R7-wired). The full `--cleanup` surface (ACs 18–28) is **excluded** — deferred to v1.1 — so this estimate covers only the `[shipped-in-v1.0]` / `[partial-v1.0]` slices. Per the roadmap's lean-index convention the per-spec estimate lives here, not in the roadmap list; the roadmap's aggregate effort estimate rolls it up.

---

## Version bump (install-affecting)

O2 authors the bundled `schemas/progress-v1.json` — an installed-package change that takes effect only via `install.sh`'s version-gated `npm install -g .`. Per the pre-1.0 install-version bump discipline (roadmap § "Pre-release chores and release gate"), O2's implementation PR **minor-bumps `package.json` `version`** (`0.MINOR.0`, e.g. `0.1.0` → next minor, per the roadmap's minor-increment discipline — the framework package version, not the `progress-v1` `schemaVersion`). The `--recover` / `--list-recoverable` / `--cleanup` dispatch lives in `SKILL.md`, which is copied every install and does not itself force the bump.

## Dependencies

- **F1** — zone 2 layout. Recovery operates entirely inside `.gan-state/runs/<run-id>/`.
- **F2** — `validateAll()` non-aborting mode.
- **E1** — gan-recover role contract; orchestrator's snapshot model; SKILL.md's
  `--recover` / `--list-recoverable` short-circuit dispatch.
- **F3** — `progress-v1.json` schema (added in this sprint if not already present).
- **E1 (shipped), not O1** — the fail-open contract `--recover` needs is the **non-aborting `validateAll()`** that already ships (`validate.ts`'s non-aborting mode), so a known-broken project stays recoverable. An earlier draft listed **O1** here, but O1 ships *after* O2 (later in the implementation order) and only *observes* resolution — it does not provide this behaviour. The real dependency is on shipped code; O2 must not declare a dependency on a spec that lands after it.
- **T1** — the run trace recovery reads to reconstruct sprint and counter state.
- **A1** — the loop-halt reasons (`failed-loop-detected`) recovery resumes from and the trace-as-only-counter reconstruction it shares.
- **R7** — the runtime invocation bridge that makes the trace emittable/readable from the markdown orchestrator; without it the trace recovery reads would be empty. (Recovery is silent on the emission mechanism, so it is compatible-once-R7-lands rather than dependent on R7's internals, but R7 is what makes recovery operative in practice.) R7 also exposes the `acquireRunLock`/`releaseRunLock` tool §8's concurrency guard uses.
- **E8** — E8 ships **before** O2 and is the *writer* of two `progress.json` fields O2's schema must accept: the `failed-evaluation-rejected` `terminalReason` value and `contractRevision`. O2 authors `progress-v1.json`, so its schema **must** include these or every E8-renegotiated run fails validation once the strict schema lands. `--recover` must also resume a run halted on E8's renegotiation cap (see AC). This writer-before-schema ordering is the **F5/R6 lag class** and the seam to watch: AC 29 is its integration test, and the strict-schema reconciliation AC (§ schema, above) is the **hard merge gate** against it. **Co-landing O2's schema with E8 — or landing it in E8's immediate wake — is the safe sequencing:** the longer E8's fields go un-schema'd, the more writers can drift before the strict `additionalProperties: false` schema arrives, so if O2 lands later its merge gates on a fixture *captured from a real E8-renegotiated run*, not a hand-written one.

## Implementation notes

- **SKILL.md changes only.** No new agent file. F7 (#23) already shipped the three
  short-circuit *handlers* (`--list-recoverable`, `--recover`, `--cleanup`) in the
  SKILL.md flag table and the operative `--cleanup` prose; O2 **revises** them, it does
  not add them: it (a) **authors the status-keyed resume dispatch** `--recover` falls
  through to (§5 step 7 — absent from shipped SKILL.md), and (b) **replaces F7's operative
  `--cleanup` destructive prose with the v1.0 `[deferred-to-v1.1]` stub** (§5.5). Leaving
  F7's destructive `--cleanup` prose in place would fail AC 31.
- **Recovery is independent of telemetry.** Telemetry is a separate concern owned by O3; recovery neither reads nor depends on any telemetry surface. (There is **no `--telemetry-dir` flag** — an earlier draft referenced one; it is absent from `runtime-knobs.md` and is removed here. O3 owns `--no-telemetry`.)
- **Schema creation (not a bump).** `schemas/progress-v1.json` does **not** exist
  today, so this sprint **creates** it at v1 — covering the legacy fields (incl.
  `workspace`) plus the recovery additions (`terminal`, `terminalReason`,
  `terminalAt`, `contractRevision`, `projectRoot`, `overlaysAtSnapshot`,
  `recoveryHistory`). Per the schema-versioning ruling (roadmap § "Schema-versioning
  ruling"; E8 § "Schema and surface additions"), were the file already present these
  additive fields would stay v1 in place — only a rename/semantic change forces `v2`.
- **Tests live under `tests/integration/recovery/`** (new directory, follows the
  pattern of `tests/integration/snapshot-freshness.test.ts` and
  `tests/integration/first-run-nudge.test.ts` from Phase 3 Sprint 6).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Authoring strict `progress-v1.json` breaks Phase 3 tests that wrote free-form `progress.json` | `progress-v1.json` is **created** at v1 (not a bump — it does not exist today); existing tests that reference `progress.json` are updated to the strict shape. The `_audit-post-r.md` discipline applies. |
| User runs `--recover` against a run from before this spec lands (no `terminal` field) | Treat missing `terminal` as `false` (recoverable). Acceptable — pre-revision runs were always recoverable in spirit. |
| `recoveryHistory[]` grows unbounded across many recoveries of a chronically failing run | Bounded by user behaviour; in practice 1-3 entries typical. No GC needed in v1. |
| Filesystem race: another process writes to the run directory mid-recovery | The §8 `link(2)` run-lock **is** the v1.0 cross-process guard — `--recover` acquires it, so a concurrent run or recover fails closed (`InvariantViolation` / `ConcurrentRunInProgress`). Best-effort on network filesystems (per §8); **not** out of scope. |
| Overlay drift hash check has high false-positive rate (whitespace edits) | Documented as acceptable; the warning is informational, not blocking. v2 could move to AST-level diff. |
| `validateAll()` non-aborting mode surfaces too much noise during recovery | Recovery report sections are clearly separated (preflight / drift / validation). The user can scan the section they care about. |
