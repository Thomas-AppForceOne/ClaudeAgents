# O2 — Recovery

> **Status:** prescriptive. The first prescriptive authoring of this spec landed during the post-E1 revision break per the [roadmap](roadmap.md#revision-break--post-e1-audit--o2-first-prescriptive-revision). The earlier descriptive draft is retired; everything below is implementable.

**Decisions baked in (for git-history readers).** The post-E1 revision break enumerated six design choices; this spec was authored against these defaults:

1. `gan-recover` placement: **orchestrator-internal in `skills/gan/SKILL.md`** (no separate agent file).
2. Overlay-drift policy: **warn-and-continue** (drift surfaces in the recovery report; recovery proceeds).
3. Cross-project recovery: **refused** (no `--project-root` override in v1; `progress.json.projectRoot` must match the current resolved root).
4. Greenfield runs: **out of scope for v1** (recovery refuses runs whose `targetDir` is null).
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

Three coordinated mechanisms, all post-E1:

1. **Run directories persist as the recovery surface.** No archive copy step. The
   orchestrator marks runs terminal at teardown (writing `terminal: true` plus a
   `terminalReason` to `progress.json`) but never moves or deletes the directory. A
   recoverable run is one whose `progress.json` has `terminal: false` (or is missing
   `terminal` for backwards-compat — see migration below).

2. **Recovery is re-attach + resume, not copy + restore.** `--recover`:
   - Calls `validateAll()` in non-aborting mode (per O1 / E1's recovery contract — the
     user must be able to recover a known-broken project).
   - Reads the target run's `progress.json` directly from `.gan-state/runs/<run-id>/`.
   - Re-attaches the git worktree from the recorded `runBranch`.
   - Compares the archived overlay state in `progress.json.overlaysAtArchive` against
     the current `getResolvedConfig().overlays`; surfaces drift as a recovery-report
     warning.
   - Falls through to the existing in-`SKILL.md` resume state machine.

3. **`--list-recoverable` enumerates `.gan-state/runs/*/progress.json`** and filters by
   `terminal: false` (recoverable) or includes terminal entries when the user asks for
   history. Read-only; never mutates state.

The `.gan-state/modules/` subdirectory is **never touched** by recovery — F1's zone-2
ownership invariant. Module state belongs to modules; run-state has its own lane.

> **F8 supersession (module-state relocation).** Per [F8](F8-centralized-module-state-store.md), durable module state no longer lives under `.gan-state/modules/`; it moves to a separate, repo-keyed store (`<module-state-root>/<repo-key>/`, default `~/.gan-module-state/`). The "never touched by recovery" invariant carries over verbatim to the new location: recovery and `--cleanup` never read or write the module store. Read every `.gan-state/modules/` reference below as the relocated module store.


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
hooks check `.gan-state/runs/<run-id>/worktree/` instead of `.gan/worktree/`.

> **F7 supersession (run-data relocation).** Per [F7](F7-central-run-data-store-and-worktree-execution.md), the run *data* shown above — `progress.json`, `spec.md`, the `sprint-*` artifacts, `trace/`, and `telemetry/` — no longer lives under `<projectRoot>/.gan-state/runs/<run-id>/`. It lives in the central, repo-keyed store at `<store-root>/<repo-key>/runs/<run-id>/` (default `~/.gan-runs-data`), so it survives removal of the worktree it ran in. Only the `worktree/` subtree stays at `<project>/.gan-state/runs/<run-id>/worktree/` (gan-created, cases 1b/1c) or is the engineer's own worktree (case 1a). Read every `.gan-state/runs/<run-id>/` *data* path below as the central run dir; read `<projectRoot>` as the **main-worktree root** (the parent of `git rev-parse --git-common-dir`), which makes run *discovery* (`--list-recoverable`, `--cleanup`) and the lock **repo-wide** across all worktrees of the repo; and read `run.lock` as `<store-root>/<repo-key>/run.lock`. **`--recover` is the exception:** resuming a run is bound to its recorded `workspace.worktreePath` and refuses from any other worktree (per F7 — a run resumes only in the worktree it executed in). O2's full implementation (later in the v1.0 order) applies this uniformly.

### 2. `progress.json` extensions for recovery

The post-E1 `progress.json` schema gains four fields beyond the legacy set:

```json
{
  "runId": "20260503T143010-b8e1",
  "status": "clarifying | planning | negotiating | building | evaluating | complete | failed",
  "currentSprint": 3,
  "currentAttempt": 1,
  "totalSprints": 7,
  "completedSprints": 2,

  "projectRoot": "/Users/thak/projects/myapp",
  "runBranch": "gan/20260503T143010-b8e1",
  "baseBranch": "develop",
  "startingBranch": "develop",

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

Enumerated `terminalReason` codes:

```
complete                       Run finished all sprints successfully
failed-max-attempts            Sprint exhausted maxAttempts
failed-budget                  Hit maxAttemptsTotal or maxMinutes
failed-loop-detected           A1 halt — see safetyHalt event for discriminator
failed-clarifier-error         E5 clarifier itself errored (e.g. LLM call failed)
aborted-by-user                User answered N at resume prompt OR typed [c]ancel
                               at the E5 draft preview action menu
aborted-planner-error          Planner failed (schema, refusal, etc.)
aborted-contract-failed        Contract negotiation hit max revisions
aborted-validation-failed      validateAll() failed in aborting mode
```

`failed-loop-detected` is written by all three A1 halt reasons (`roleCeilingExceeded`, `sprintBudgetExceeded`, `editOscillation`); the specific reason lives in the corresponding `safetyHalt` trace event's payload, not in `progress.json`. E5's draft preview auto-approves on timeout (not a halt), so there is no terminal code for "user did not respond." Explicit user `[c]ancel` at the action menu maps to `aborted-by-user`.

Schema lives at `schemas/run-state/progress-v1.json` per F3's naming conventions; this
sprint adds it to the schema set if it isn't already present.

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

### 4. `--list-recoverable`

New top-level flag. Parsed at SKILL.md flag-table dispatch. Behaviour:

1. Calls `validateAll()` in non-aborting mode (per E1's recovery contract).
2. Enumerates `<projectRoot>/.gan-state/runs/*/progress.json`.
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

If no runs found: `No runs found at <projectRoot>/.gan-state/runs/.` Exit 0.

### 5. `--recover [--run-id X]`

New top-level flag. Parsed at SKILL.md flag-table dispatch. Per E1's recovery contract,
runs `validateAll()` in non-aborting mode first.

1. **Resolve target run.**
   - If `--run-id X`: look up `<projectRoot>/.gan-state/runs/X/progress.json`. Missing
     → `Run <X> not found at <projectRoot>/.gan-state/runs/X/.` Exit 1.
   - Otherwise: enumerate runs, filter `terminal: false`, sort by mtime desc, pick the
     first. None → `No recoverable runs found at <projectRoot>/.gan-state/runs/.`
     Exit 1.

2. **Preflight.**
   - Read `progress.json` from the run directory.
   - **Project-root check**: if `progress.json.projectRoot` exists and
     differs from the orchestrator's resolved current project root, refuse:
     `Run <runId> was created at <oldRoot>; cannot recover from <currentRoot>. Cross-
     project recovery is not supported.` Exit 1.
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

4. **Re-attach the worktree.**
   - `git worktree add <projectRoot>/.gan-state/runs/<runId>/worktree <runBranch>` (no
     `-b` — the branch exists).
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

7. **Fall through to the existing resume state machine.** The state machine in
   `skills/gan/SKILL.md` handles `clarifying`/`planning`/`negotiating`/`building`/`evaluating`
   resume. It does not need a recovery-specific path. Specifically:
   - `clarifying` resume: the orchestrator reads the most recent `clarified-spec.md`
     (and any `clarified-spec.md.round-N` from the round counter on disk), re-presents
     the draft preview with the action menu, and the user picks up where they left off.
     Round count is preserved across recovery — a halt mid-round-2 resumes at round-2,
     not round-1.

### 5.5. `--cleanup [--run-id X] [--all] [--include-terminal] [--yes]`

New top-level flag. Parsed at SKILL.md flag-table dispatch. Symmetric to `--recover` in resolution semantics, but **destructive** — it removes the resolved run(s) from disk rather than resuming them.

Per E1's recovery contract, runs `validateAll()` in non-aborting mode first. Does **not** acquire the run lock (it operates on non-active runs; an attempt to clean up an active run is refused per the active-run check below).

1. **Resolve target run(s).** Mirrors `--recover`:
   - `--run-id X`: target a single run by id. Missing → `Run <X> not found at <projectRoot>/.gan-state/runs/X/.` Exit 1.
   - `--all`: target every non-terminal run.
   - `--all --include-terminal`: target every run regardless of terminal flag.
   - Default (no `--run-id` and no `--all`): the most recent non-terminal run (same selection as `--recover`). None found → `No non-terminal runs found at <projectRoot>/.gan-state/runs/.` Exit 0 (not an error — nothing to do).

2. **Active-run guard.** For each resolved target:
   - If `<projectRoot>/.gan-state/run.lock` exists, parse it for `runId` + `pid`.
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

4. **Per-run cleanup.** For each confirmed target:
   - `git worktree remove <projectRoot>/.gan-state/runs/<runId>/worktree --force` (silent if not registered).
   - `git worktree prune` (runs once at the end of the batch, not per-run).
   - `git branch -D <runBranch>` (silent if branch missing).
   - `rm -rf <projectRoot>/.gan-state/runs/<runId>`.
   - On any step failing: log a per-run warning naming the step and the run, continue with the next run. The rm is the only step whose failure escalates to exit 1 for the whole batch (the directory is the source-of-truth artefact).

5. **Final report.**
   ```
   Cleaned up 2 runs. Freed 59 MB.
   ```
   If any per-run warnings fired, summarise: `1 run had teardown warnings; see above.`

**Run-branch policy.** O2's recovery design leaves run branches in git "for inspection" after terminal teardown. `--cleanup` explicitly removes them — the user's expectation when invoking cleanup is full reclamation, not partial archive.

### 6. Forbidden territory

`--recover`, `--list-recoverable`, and `--cleanup` are forbidden from:

- Reading or writing `.gan-state/modules/` (per F1 zone-2 invariant).
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
| Two `--recover` invocations against the same run, concurrently | Second invocation reads the now-non-empty `recoveryHistory[]` and refuses if the most recent entry is < 5 minutes old (heuristic lock). Document this as best-effort; cross-process locking is out of scope. |
| Recovered run completes successfully | `terminal: true` flips. The run is no longer `--list-recoverable`-recoverable. |
| Recovered run's recovery itself fails | New `recoveryHistory[]` entry records the failure. The run remains `terminal: false`; future `--recover` is not blocked. |
| Overlay drift but only formatting whitespace | Hashes still differ. Warning still fires. Acceptable false-positive; the user can ignore. |
| Project moved on disk (`projectRoot` recorded vs current cwd diverge) | Refuse per Decision 3A. Future `--project-root` flag could relax. |
| Stale `.gan/` directory at cwd from pre-E1 era | Hard error per F1's "no migration path" rule. User deletes manually. |

### 8. Concurrent-run lockfile (v1.0)

**Decision: hard refuse on concurrent invocations against the same project root.**

A user running `/gan` in two terminals against the same project would, without a lock, produce racing run-ids both writing to overlapping zone-2 paths (per-run state dirs are unique, but module state, run-branch creation, and the worktree git operations are shared resources). v1.0 needs a deterministic failure mode rather than silent race-condition corruption.

Mechanism:

- On `/gan` invocation (any short-circuit-or-not path), the orchestrator acquires an exclusive lock at `<store-root>/<repo-key>/run.lock` (per F7; formerly `<projectRoot>/.gan-state/run.lock`) via `flock(LOCK_EX | LOCK_NB)` before any other zone-2 work. Because the key is the repo's main worktree, this serializes runs **repo-wide** — concurrent `/gan` from two worktrees of the same repo contend on the one lock.
- Lock contents: `{ runId, pid, startedAt, hostname }` written atomically (temp + rename) on acquisition.
- On failure to acquire (lock held by another process):
  - Read the lock contents.
  - Verify the holding process is still alive (`kill -0 <pid>` on POSIX, equivalent on Windows).
  - **If holder alive:** exit 1 with structured error `ConcurrentRunInProgress` naming the holder's `runId`, `pid`, `startedAt`, and the suggestion: "Wait for the other run to finish, or `kill <pid>` if it is stuck."
  - **If holder dead** (stale lock from a hard-killed previous run): break the lock, log a warning to stderr, acquire fresh, proceed.
- On orchestrator exit (success, halt, error, signal): release the lock by deleting the file.
- The `--print-config`, `--list-recoverable`, and `--help` short-circuits do NOT acquire the lock — they are read-only and don't write zone 2. Only `--recover` and a regular `/gan` invocation acquire it.

Lock semantics are best-effort cross-platform: POSIX `flock` works on local filesystems but not all network filesystems. NFS-mounted project roots will see degraded lock semantics; documented limitation.

A `--no-run-lock` flag is **not** offered in v1.0. The lock is mandatory; bypassing it requires editing the lock file by hand (`rm .gan-state/run.lock`), which is a deliberate friction.

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

7. **`--recover --run-id X` for missing run.** Exit 1, message names `<projectRoot>/.gan-state/runs/X/`.

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
    worktree to `sprint-3-base-commit.txt` and respawn the generator for attempt 1
    (matching SKILL.md's `building` resume branch). No duplicate counting, no branch
    corruption.

17. **Migration: stale `.gan/` directory hard error.** Per F1 acceptance criteria — a
    project with a pre-existing `.gan/` halts with a hard error instructing manual
    deletion. `--recover` and `--list-recoverable` honor this rule.

18. **`--cleanup --run-id X` removes a single run.** After cleanup,
    `.gan-state/runs/X/` is gone, `git branch -l 'gan/run/X*'` is empty, and
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
    `<projectRoot>/.gan-state/runs/X/`.

27. **`--cleanup` empty case.** Project with no runs → `No non-terminal runs found at
    <projectRoot>/.gan-state/runs/.` Exit 0 (not an error — nothing to do).

28. **`--cleanup` is read-only against `.gan-state/modules/`.** Regression test seeds
    `tests/fixtures/<fixture>/.gan-state/modules/dummy/state.json` and asserts the file
    is byte-identical after `--cleanup --all --include-terminal`.

Tests cover at minimum: success path for 1-4, 6, 11, 13-16, 18-21, 23, 25, 27; failure path for 7-10, 17, 22, 24, 26.

---

## Dependencies

- **F1** — zone 2 layout. Recovery operates entirely inside `.gan-state/runs/<run-id>/`.
- **F2** — `validateAll()` non-aborting mode.
- **E1** — gan-recover role contract; orchestrator's snapshot model; SKILL.md's
  `--recover` / `--list-recoverable` short-circuit dispatch.
- **F3** — `progress-v1.json` schema (added in this sprint if not already present).
- **O1** — fail-open contract for `--recover` validation behaviour.

## Implementation notes

- **SKILL.md changes only.** No new agent file. The flag-dispatch table
  in SKILL.md gains three short-circuit handlers (`--list-recoverable`, `--recover
  [--run-id X]`, `--cleanup [--run-id X] [--all] [--include-terminal] [--yes]`).
- **No external archive root.** `--telemetry-dir` and `--no-telemetry` no longer affect
  recovery; telemetry is a separate concern. (Telemetry directories may still receive
  copies of `progress.json` etc. for outcome tracking, but recovery does not depend on
  them.)
- **Schema bump.** `progress.json`'s shape changes (gains `terminal`, `terminalReason`,
  `terminalAt`, `projectRoot`, `overlaysAtSnapshot`, `recoveryHistory`). Per the
  pre-1.0 no-backward-compat rule, this is a `schemaVersion` bump on the run-state
  schema if `schemas/run-state/progress-v1.json` exists, or first creation of that
  file.
- **Tests live under `tests/integration/recovery/`** (new directory, follows the
  pattern of `tests/integration/snapshot-freshness.test.ts` and
  `tests/integration/first-run-nudge.test.ts` from Phase 3 Sprint 6).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `progress.json` schema bump breaks Phase 3 tests | Schema version is bumped on the on-disk format; in-memory shape is additive. Existing tests that reference `progress.json` get updated. The `_audit-post-r.md` discipline applies. |
| User runs `--recover` against a run from before this spec lands (no `terminal` field) | Treat missing `terminal` as `false` (recoverable). Acceptable — pre-revision runs were always recoverable in spirit. |
| `recoveryHistory[]` grows unbounded across many recoveries of a chronically failing run | Bounded by user behaviour; in practice 1-3 entries typical. No GC needed in v1. |
| Filesystem race: another process writes to the run directory mid-recovery | Best-effort. Document that recovery assumes exclusive access to `.gan-state/runs/<run-id>/`. Cross-process locking is out of scope (v2 candidate). |
| Overlay drift hash check has high false-positive rate (whitespace edits) | Documented as acceptable; the warning is informational, not blocking. v2 could move to AST-level diff. |
| `validateAll()` non-aborting mode surfaces too much noise during recovery | Recovery report sections are clearly separated (preflight / drift / validation). The user can scan the section they care about. |
