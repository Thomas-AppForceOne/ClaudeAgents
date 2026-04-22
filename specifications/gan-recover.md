# /gan Recovery — Spec

**Status:** Specification (ready for implementation)
**Scope:** `skills/gan/SKILL.md` in this repo
**Target repo:** ClaudeAgents (this repo). No dependencies on any external consumer repo.

---

## Problem

When a `/gan` run aborts (user answered `N` to resume, budget cap hit, an agent raised a fatal blocking condition, or the user manually stopped mid-run), the current teardown deletes `.gan/` from the invocation cwd. The run branch (`gan/<run-id>`) survives because it lives in git, but the orchestration state required to continue the attempt loop — `progress.json`, sprint contracts, evaluator feedback, the generator's spec rendering, the base-commit SHAs — is destroyed.

Consequence: to recover any value from a failed run you either cherry-pick commits off the run branch and finish the work by hand, or pay to re-run `/gan` from scratch. The harness has no "resume this specific failed run" mechanism.

The user's expectation — and the design target of this spec — is:

```
/gan --recover              # resume the most recent non-complete run
/gan --recover --run-id X   # resume a specific run
/gan --list-recoverable     # print a table of archived runs
```

---

## Solution summary

Two changes, tightly coupled:

1. **Archive on abort** (replace the current delete). On every code path that tears down a run — success, failure, user abort, budget cap, interrupted resume — move `.gan/` to `<telemetry-dir>/runs/<run-id>/gan-state/` instead of deleting. Write a small `archive-metadata.json` alongside it describing the archive.
2. **`--recover` flag.** Discover an archive, restore it to `.gan/` at the invocation cwd, re-attach the git worktree from the saved run branch, then fall through to the existing Step 0 resume state machine.

`--list-recoverable` is a small companion that reads the telemetry directory and prints a summary table. No state changes.

The existing Step 0 resume machinery (`planning` | `negotiating` | `building` | `evaluating`) is sufficient once `.gan/` is restored — recovery does not need its own state machine.

---

## Dependencies and assumptions

This spec depends only on behavior already present in `skills/gan/SKILL.md` and common POSIX/git tooling. Listed exhaustively so an implementer can verify each:

| Dependency | Already present? | Where |
|---|---|---|
| Telemetry directory resolution: `--telemetry-dir` > `$GAN_TELEMETRY_DIR` > `$HOME/.gan-telemetry` | Yes | SKILL.md Step 0.75 |
| `runId` format (`<YYYYMMDDTHHMMSS>-<4 hex>`) | Yes | Step 0.75 |
| `progress.json` fields `runBranch`, `baseBranch`, `worktreePath`, `telemetry.runId`, `telemetry.dir`, `startingBranch` | Yes | Step 0.6 + Step 0.75 |
| `.gan/sprint-N-base-commit.txt` for per-sprint reset | Yes | Step 2b |
| Step 0 resume state machine | Yes | Step 0 |
| Worktree re-attach without `-b` (`git worktree add <path> <branch>`) | Yes (documented for the `building` resume branch in Step 0) | Step 0 |
| `python3` for JSON reads/writes | Yes — SKILL.md already requires it | throughout |
| `git`, `mv`, `cp -R`, `find`, `sort` | Yes — POSIX baseline | — |

**No external-repo dependencies.** The spec does not reference any file, script, or convention from any repo that consumes ClaudeAgents.

### SKILL.md delivery path — clarification

`~/.claude/skills/gan/SKILL.md` is currently a **regular file** on a developer's machine, not a symlink to this repo. Schemas under `~/.claude/skills/gan/schemas/` are symlinked to `ClaudeAgents/skills/gan/schemas/`, but SKILL.md itself is not.

The implementer of this spec must:

1. Edit `skills/gan/SKILL.md` in this repo as the source of truth.
2. Update `install.sh` (top of this repo) so installation symlinks `~/.claude/skills/gan/SKILL.md` → `ClaudeAgents/skills/gan/SKILL.md`, matching the pattern already used for `agents/*.md` and `skills/gan/schemas/`. Back up any existing regular-file SKILL.md as `SKILL.md.pre-symlink` before replacing.
3. Note in this spec's implementation PR that operators on machines with a pre-existing regular-file SKILL.md must re-run `install.sh` to pick up the change. The run-time behavior of the skill does not detect or fix this — it's a provisioning step.

If the implementer decides not to move SKILL.md into the symlink pattern, they must instead document that this spec's changes need to be applied to each developer's local `~/.claude/skills/gan/SKILL.md` by hand, and justify the divergence from the agents/schemas pattern. The symlink path is preferred.

---

## Detailed design

### 1. Archive layout

For any run, successful or not, the archive is:

```
<telemetry-dir>/runs/<run-id>/
├── config.json              # already written at Step 0.75 — unchanged
├── outcome.json             # already written at run end — unchanged
├── gan-state/               # NEW — the contents of .gan/ at teardown
│   ├── progress.json
│   ├── spec.md
│   ├── sprint-N-contract.json
│   ├── sprint-N-feedback-A.json
│   ├── sprint-N-objection-A.json       (if any)
│   ├── sprint-N-base-commit.txt
│   └── ...every other file the run wrote to .gan/
└── archive-metadata.json    # NEW — describes the archive
```

`archive-metadata.json` schema:

```json
{
  "runId": "20260421T184210-a9f2",
  "archivedAt": "2026-04-22T10:15:30Z",
  "reason": "complete | failed-max-attempts | failed-budget | aborted-by-user | aborted-interrupted-resume | aborted-planner-error | ...",
  "recoverable": true,
  "recoverabilityNotes": "",
  "runBranch": "gan/20260421T184210-a9f2",
  "baseBranch": "develop",
  "targetDir": "/Users/x/projects/foo",
  "startingBranch": "develop",
  "currentSprint": 3,
  "totalSprints": 7,
  "completedSprints": 2,
  "lastKnownStatus": "building"
}
```

Field semantics:

- **`reason`** — human-readable, matched against the enumerated set below so `--list-recoverable` can filter/group. New reason codes are additive; unknown codes must be displayed verbatim, not rejected.
- **`recoverable`** — `false` when the run reached terminal state (`complete`, `failed-max-attempts`, `failed-budget`) and there is nothing to continue. `true` otherwise. `--recover` refuses `recoverable: false` archives with a clear message.
- **`recoverabilityNotes`** — populated by the archive writer when it can detect a reason recovery will fail (e.g. run branch missing from the target repo at archive time). Informational; does not by itself set `recoverable: false`.
- **`runBranch`, `baseBranch`, `targetDir`, `startingBranch`** — copied from `progress.json` so `--list-recoverable` can render them without opening the state bundle.
- **`lastKnownStatus`** — the `progress.json.status` at archive time. Callers render it.

### 2. When to archive

Replace every `rm -rf .gan` or equivalent deletion with a move to the archive. The places in SKILL.md that currently tear state down (search current text for `delete \.gan`, `worktree remove`, and the descriptive "delete `.gan/` contents" in Step 0):

| Code path | Current behavior | New behavior | `reason` |
|---|---|---|---|
| Step 0 resume prompt, user answers `N` | Delete `.gan/` contents | Move `.gan/` to archive | `aborted-interrupted-resume` |
| Step 2b sprint passes (all criteria met) | Delete `.gan/sprint-N-base-commit.txt`, `.gan/sprint-N-contract-draft.json` | Leave in place; archived at run end | (N/A — no archive yet) |
| Step 2b sprint fails at `attempt == maxAttempts` | Status `failed`, teardown | Move `.gan/` to archive after final `progress.json` write | `failed-max-attempts` |
| Step 2b budget cap (`maxAttemptsTotal`, `maxMinutes`) | Status `failed`, teardown | Archive | `failed-budget` |
| Step 1 planner error / schema validation | Status `failed`, teardown | Archive | `aborted-planner-error` (or a more specific code — see below) |
| Step 2a contract negotiation failure | Status `failed`, teardown | Archive | `aborted-contract-failed` |
| Step 3 all sprints complete | Worktree teardown, status `complete` | Archive, `recoverable: false` | `complete` |
| User manual `Ctrl-C` / session end mid-run | Currently: state remains in cwd's `.gan/` on disk | Unchanged — we cannot run code on an interrupted session. The next `/gan` invocation handles this: if it detects a stale `.gan/` with a non-terminal status that wasn't gracefully archived, it treats it as an implicit `Ctrl-C` case and offers to archive-then-recover. See Step 0 amendment below. |

Enumerated `reason` codes in this spec's v1:

```
complete
failed-max-attempts
failed-budget
aborted-by-user
aborted-interrupted-resume
aborted-planner-error
aborted-contract-failed
aborted-stale-state              (when .gan/ was left in cwd from a Ctrl-C)
```

Implementers may add codes without breaking this spec, provided `--list-recoverable` renders unknown codes verbatim.

### 3. Archive write procedure

Immediately before the existing worktree teardown (`git worktree remove .gan/worktree --force`), execute in this order:

1. Resolve `<archive-root>` = `<telemetry-dir>/runs/<run-id>/`. If telemetry is disabled (`--no-telemetry`) there is no telemetry dir → see **Telemetry-disabled fallback** below.
2. `mkdir -p <archive-root>/gan-state`.
3. Remove the worktree from git (`git worktree remove .gan/worktree --force || true`) **before** the move. This detaches `.gan/worktree/` so `.gan/` can be moved as a plain directory. The run branch is untouched; `git worktree list` no longer references the path.
4. `mv .gan/* <archive-root>/gan-state/` — move every file. Use `mv` not `cp` so `.gan/` is left empty (or removed) in cwd.
5. Remove the now-empty `.gan/` directory: `rmdir .gan 2>/dev/null || true`.
6. Compose `archive-metadata.json` from `progress.json` fields + the teardown `reason`. Write it to `<archive-root>/archive-metadata.json`.
7. If the run branch no longer exists in the target repo for any reason (`git -C <target> rev-parse --verify <runBranch>` fails), set `recoverabilityNotes` to `"run branch <X> not present in <targetDir>"` and `recoverable: false`.

Failure modes the writer must handle:

- **Telemetry directory unwritable** → print a loud error on stderr (`CRITICAL: could not archive .gan/ to <path>: <error>; state will be deleted instead`) and fall back to the current delete behavior. Never leave half-archived state.
- **Partial `mv`** (e.g. disk full mid-move) → move what you can, write `archive-metadata.json` with `recoverable: false` and a note describing the partial move, then continue teardown.
- **Run invoked with `--no-telemetry`** → see fallback below.

#### Telemetry-disabled fallback

`--no-telemetry` is a valid flag. In that mode there is no telemetry directory, but runs can still fail and still have recoverable state. Fallback:

- Archive root becomes `<cwd>/.gan-archive/<run-id>/` — sibling to the cwd where `.gan/` lived.
- Print a one-line notice at archive time: `Telemetry disabled — archiving to .gan-archive/<run-id>/. Move or delete when done.`
- `--recover` and `--list-recoverable` must search this sibling path **in addition to** the telemetry dir when telemetry is disabled. When telemetry is enabled they only search the telemetry dir.

### 4. `--list-recoverable`

New top-level flag. Parsed at Step 0 before the resume check. Behavior:

1. Resolve telemetry dir (same precedence as elsewhere). If telemetry is disabled, also scan `<cwd>/.gan-archive/`.
2. Enumerate every `<telemetry-dir>/runs/<run-id>/archive-metadata.json`.
3. Print a table sorted by `archivedAt` desc:

```
RUN ID                    ARCHIVED AT           STATUS              SPRINT   REASON                        RECOVERABLE
20260422T031540-b8e1      2026-04-22T03:18:02Z  building            3/7      aborted-by-user               yes
20260421T210000-a9f2      2026-04-21T21:45:11Z  failed              5/7      failed-max-attempts           no
20260420T120000-aaaa      2026-04-20T12:02:13Z  complete            7/7      complete                      no
```

4. Exit 0. Do not start a run, do not enter the resume flow.

Column widths are advisory; any format that keeps columns aligned is acceptable. The `SPRINT` column is rendered as `<currentSprint>/<totalSprints>` from `archive-metadata.json`.

If no archives are found: print `No recoverable runs found at <telemetry-dir>.` and exit 0.

### 5. `--recover [--run-id X]`

New top-level flag. Parsed at Step 0 before the resume check. Behavior:

1. **Refuse if `.gan/` already exists at cwd.** Print: `Cannot recover: .gan/ already exists at <cwd>. Move or delete it first.` Exit 1. This prevents clobbering an in-progress run with a previous run's state.
2. **Resolve the target archive.**
   - If `--run-id X` was passed: look up `<telemetry-dir>/runs/X/archive-metadata.json`. If missing → `Archive for run <X> not found at <path>.` Exit 1.
   - Otherwise: enumerate archives, filter `recoverable: true`, sort by `archivedAt` desc, pick the first. If none → `No recoverable runs found at <telemetry-dir>.` Exit 1.
3. **Preflight the target repo state.**
   - Resolve `targetDir` from `archive-metadata.json`. If null (greenfield run), recovery is not supported in v1 (see **Out of scope** below). Print a clear error and exit 1.
   - `git -C <targetDir> rev-parse --verify <runBranch>` — if the branch is gone (force-deleted, pruned), recovery cannot proceed. Print: `Run branch <runBranch> is missing from <targetDir>. The archive's state is preserved at <archive-root> but cannot be resumed.` Exit 1.
   - Verify the target repo's working tree is clean (same check as Step 0.5). If dirty, print the same abort message as Step 0.5 and exit 1.
4. **Restore state.**
   - `mkdir .gan`
   - `cp -R <archive-root>/gan-state/* .gan/` (copy, don't move — the archive is authoritative; recovery must be re-runnable if something goes wrong)
5. **Re-attach the worktree.**
   - Read `worktreePath` from restored `progress.json`. Its parent directory should be `<cwd>/.gan/worktree` by convention.
   - `git -C <targetDir> worktree add <worktreePath> <runBranch>` (no `-b` — the branch exists).
   - If the worktree add fails because the path is already registered, `git -C <targetDir> worktree prune` then retry once.
6. **Reset `progress.json`'s volatile fields** so the resume state machine handles the rest:
   - Set `status` to whatever it was at archive time (already in the restored file).
   - Do NOT modify `currentSprint`, `currentAttempt`, `attemptsTotal`, `completedSprints`. They were correct at archive time.
7. **Mark the archive consumed.** Update `archive-metadata.json` in place: set `recoverable: false`, add `recoveredAt: <ISO now>`, add `recoveredTo: <cwd>`. This prevents a second `--recover` from competing for the same state.
8. **Write the confinement marker** (if the target project requires it — see **Confinement marker** below) and proceed to Step 0's existing resume state machine. Skip the "interrupted run — resume?" prompt; recovery is an explicit decision already.

### Confinement marker

Some consumer repos use a PreToolUse hook keyed on `.gan/confinement-active` to sandbox sub-agents to the worktree. If the archived `.gan/` contained `confinement-active`, it was copied to the new `.gan/` in step 4 automatically. No extra handling needed — this is correct because the hook is driven by file presence, not by the orchestrator.

The skill itself does not require or inspect the confinement hook; this is a consumer-repo feature. The skill's only responsibility is to preserve `confinement-active` through archive and restore, which step 4's `cp -R` already does.

### 6. Step 0 amendment for stale `.gan/`

Currently, Step 0 resume prompt handles an existing `.gan/progress.json` with non-terminal status. Extend it to distinguish gracefully-archived state (none — `.gan/` is absent) from ungraceful state (`.gan/` exists at cwd but was not archived):

Current text:
> If `.gan/progress.json` exists and `status` is not `"complete"` or `"failed"`:
> Ask the user: `Found an interrupted run at sprint {currentSprint}/{totalSprints} (status: {status}). Resume? [Y/n]`

New text (replaces the above):

> If `.gan/progress.json` exists and `status` is not `"complete"` or `"failed"`:
>
> Ask the user: `Found an interrupted run at sprint {currentSprint}/{totalSprints} (status: {status}). Resume? [Y/n/archive]`
>
> - **Y** — apply the state-machine table below.
> - **N** — archive `.gan/` with `reason: aborted-interrupted-resume` and start fresh. (Was previously "delete".)
> - **archive** — archive `.gan/` with `reason: aborted-stale-state` and exit without starting a new run. The user wanted to preserve state but not immediately resume.

Three-option prompts are a small UX change. If the implementer prefers, keep two options and always archive rather than delete on `N`; the `aborted-stale-state` path can be invoked by `/gan --recover` looking at most-recent archive.

### 7. Edge cases

| Case | Behavior |
|---|---|
| Archive exists but `runBranch` was force-deleted | `--recover` refuses in preflight with a clear message; `--list-recoverable` still shows the archive (it has historical value). |
| Archive's `targetDir` path no longer exists on this machine | Same as above — refuse with `targetDir <X> does not exist. Cannot resume a cross-machine run.` Future work: portable archives. |
| Two archives have the same `runId` | Cannot happen — run IDs include a random 4-hex suffix. But defensively: `--list-recoverable` prints both, `--recover --run-id` picks the match; `--recover` without `--run-id` picks the most recently archived by `archivedAt`. |
| User runs `/gan --recover` concurrently in two terminals against the same archive | Second `--recover` finds `recoverable: false` (set in step 7 of the recover flow) and refuses. Race condition is tolerable because step 7 is the last thing before handoff to Step 0 resume. |
| Archive directory missing `gan-state/` subdir (partial archive from earlier disk-full) | Refuse with `Archive <runId> is incomplete (no gan-state/). Not recoverable.` |
| User modifies the archive by hand before `--recover` | Not supported. Recovery trusts the archive's contents verbatim. |
| `--no-telemetry` run aborts, then user re-runs with telemetry enabled, then `--recover` | Both locations are searched (see fallback section). The fallback sibling path takes priority if both exist for the same run id (shouldn't happen — different telemetry settings → different run ids). |

### 8. Out of scope for v1

Document these as deferred so future specs can pick them up:

- **Greenfield runs** (`--target` not passed). The archived `progress.json` has `targetDir: null`. v1 refuses to recover these because the `app/` directory created at Step 0.6 is not tracked by the archive, and re-creating it needs the original greenfield init logic. A v2 could archive `app/` alongside `gan-state/`.
- **Cross-machine recovery.** Absolute worktree paths and `targetDir` make archives non-portable. A v2 could relocate paths based on environment variables or a rewrite pass.
- **Automatic archive garbage collection.** v1 never deletes archives. A v2 might prune `recoverable: false` archives older than N days.
- **Recovery of the `.gan/worktree/` filesystem when the run branch was pushed but the local copy is gone.** v1 assumes the branch is still reachable from `<targetDir>`. A v2 could `git fetch` + `worktree add` if the branch is available remotely.

---

## Acceptance criteria

Each criterion has a concrete, testable assertion.

1. **Archive on user-`N` abort.** Given a run in `building` status, when the orchestrator handles a Step 0 resume prompt with user answer `N`, `.gan/` no longer exists at cwd and `<telemetry-dir>/runs/<run-id>/gan-state/` contains `progress.json` with `status: building`. `archive-metadata.json` exists with `reason: aborted-interrupted-resume` and `recoverable: true`.
2. **Archive on max-attempts failure.** Given a sprint that exhausts `maxAttempts`, the teardown archives `.gan/` with `reason: failed-max-attempts`, `recoverable: false`.
3. **Archive on success.** A successful run (`status: complete`) archives with `reason: complete`, `recoverable: false`.
4. **`--list-recoverable` without archives.** Fresh telemetry dir → prints `No recoverable runs found at <telemetry-dir>.` Exit 0.
5. **`--list-recoverable` with archives.** Three archives (one complete, one failed, one aborted) → prints all three sorted by `archivedAt` desc. Exit 0.
6. **`--recover` without `--run-id` picks most recent recoverable.** Given two archives (newer `recoverable: false`, older `recoverable: true`), `--recover` picks the older one. Given two archives both `recoverable: true`, picks the newer.
7. **`--recover` refuses when `.gan/` exists.** Exit 1 with the documented message. `.gan/` is not modified.
8. **`--recover` refuses when run branch is gone.** Exit 1 with the documented message. `.gan/` is not created. Archive `archive-metadata.json` is not modified.
9. **`--recover` restores state and re-attaches worktree.** After successful `--recover`, `.gan/progress.json` equals the archived file, `.gan/worktree/` is a git worktree of the target repo checked out to `runBranch`, and `archive-metadata.json.recoverable` is `false` with `recoveredAt` + `recoveredTo` populated.
10. **`--recover` then normal resume works end-to-end.** After `--recover` on a run archived at `building/sprint 3/attempt 1`, the orchestrator enters the Step 0 building-branch resume (reset worktree to `sprint-3-base-commit.txt`, respawn generator for attempt 1). No duplicate attempt counting, no branch corruption.
11. **`--no-telemetry` fallback.** A `--no-telemetry` run that fails archives to `<cwd>/.gan-archive/<run-id>/` with a stderr notice. `--list-recoverable` from the same cwd finds it.
12. **Archive write atomicity.** The move sequence (worktree detach → `mv .gan/* …`) either completes fully or leaves `.gan/` intact + logs a critical error. No partial state left under `<telemetry-dir>` without a matching `archive-metadata.json`.

Tests must cover:

- **Success path** for 1, 5, 6, 9, 10 — a working recovery flow.
- **Failure path** for 7, 8, 12 — refusals and write failures.

Per ClaudeAgents' testing rules (see `CLAUDE.md` in this repo if one exists; otherwise the standard rule "new or updated code must be covered by tests exercising both success and at least one failure path"), no criterion should have happy-path coverage only.

---

## Implementation notes

- **SKILL.md is prose.** The changes here are additions and edits to `skills/gan/SKILL.md`, plus a one-line change to `install.sh` for the symlink. No Python, no shell scripts, no schemas to change.
- **No schema changes.** `progress.json` schema is unchanged. `archive-metadata.json` is a new document; its schema lives in this spec and should be copied into `skills/gan/schemas/archive-metadata.schema.json` for consistency with the existing pattern (see `progress.schema.json`, `contract.schema.json`, etc.).
- **Step numbering.** The new `--recover` and `--list-recoverable` handling should slot in between Step 0 (resume) and Step 0.5 (target preflight). Suggested: rename current Step 0 to Step 0a (resume), new Step 0b (recover / list-recoverable), leaving downstream step numbers intact.
- **`/gan --recover` does not need to honor other flags.** It ignores `--spec`, `--specs`, `--target`, `--max-attempts`, `--threshold`, `--label` — all of those are read from the archive. `--telemetry-dir` and `--no-telemetry` are honored because they drive archive discovery. `--run-id` is specific to `--recover`. Document that mixing `--recover` with spec flags is a usage error and prints `--recover takes only --run-id; other flags are read from the archive. Ignored: <list>`.
- **Timestamps.** Every new timestamp in `archive-metadata.json` is UTC ISO 8601 (`2026-04-22T10:15:30Z`), matching existing timestamps elsewhere in the skill.
- **Validation.** Add `archive-metadata.schema.json` and validate it at archive-write time and at recovery-read time. Schema validation is already used throughout SKILL.md (see any `validate against` references).

---

## Non-goals

- Supporting recovery across machines.
- Supporting recovery when the run branch has been rewritten/force-deleted in the target repo.
- Supporting recovery for greenfield runs (no `--target`).
- Automatic cleanup of old archives.
- Changing the existing Step 0 resume behavior for graceful exits (the `status: complete` / `failed` prompt stays as-is).
- Exposing archive contents to sub-agents. Archives are orchestrator-internal.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Developers running old SKILL.md against new archives, or vice versa | `install.sh` symlink change forces a reinstall; spec instructs this in the PR body. Archive-metadata schema version field can be added in v2 if divergence becomes an issue — v1 ships without one. |
| Telemetry dir filling up with archives | Documented in "Out of scope"; GC is a v2 follow-up. Archives are small (≤10 MB typical — mostly JSON and the run's spec.md). |
| User recovers a run, that recovery fails partway, state is now half-restored | Recover is copy-based (step 4 is `cp -R`), so the archive is untouched until step 7. A failed recover leaves `.gan/` partially populated at cwd; the Step 0 resume check will catch it on the next `/gan` run. Document this in the error message: `Recovery left partial .gan/ at <cwd>. Inspect or remove before retrying.` |
| Race between `--recover` and a concurrent `/gan` run starting in the same cwd | The "refuse if `.gan/` exists" check in `--recover` step 1 plus `/gan`'s implicit creation of `.gan/` at start make this a best-effort lock. Cross-process locking is out of scope; documented behavior is "don't do that". |
