# F7 — Centralized run-data store and worktree-aware execution

## Problem

F1 brands zone 2 (`.gan-state/`) as **durable state** ("like `/var/lib`") and anchors it at "the project root." But the project root resolves to `git rev-parse --show-toplevel`, which in a **linked git worktree** is the *worktree's own directory*, not the repo's main checkout. Two failures follow:

1. **Run data dies with the worktree.** `.gan-state/` is git-ignored, so it lives only as untracked working-tree files in whatever directory `/gan` ran from. Engineers routinely create worktrees per task and remove them when done; `git worktree remove` deletes the entire directory tree, including the ignored `.gan-state/`. A multi-sprint run's trace, telemetry, and evaluator feedback — valuable, non-regenerable data — are destroyed silently. "Durable" is a promise the layout doesn't keep.
2. **Worktrees share `.git` but not run history.** Because linked worktrees share the object/ref store, the intuition is "repo-level state is shared." It isn't: a run started in worktree A is invisible to `--recover` from worktree B or the main checkout, even though they are the same repo.

A second, related friction: today `/gan` always creates its own run-scoped worktree under `.gan-state/runs/<id>/worktree/`. An engineer who already created a task worktree gets a worktree nested inside a worktree, and the generator's output lands in a throwaway directory rather than the workspace the engineer set up.

F7 closes both: run data moves to a **central, repo-keyed store** outside any worktree, and `/gan` becomes **worktree-aware** — reusing the engineer's task worktree when one exists, creating a task-named one otherwise.

F7 revises decisions that shipped in **F1** (zone-2 run-data location), **T1** (trace location), and **H1** (confinement-hook path construction). Those specs are immutable; F7 supersedes the relevant decisions here and the roadmap cross-references F7 from their entries (per the "Implemented specs are immutable" convention). Retired artifacts are listed in `specifications/retirements.md` at merge time.

## Proposed change

### 1. Central run-data store

Run data moves out of the project tree entirely:

```
~/.gan-runs-data/                       # default root; install-configurable
└── <repo-key>/                         # one directory per repo (see "repo keying")
    ├── run.lock                         # repo-level serialization lock (see §4)
    └── runs/
        └── <run-id>/                    # <YYYYMMDDTHHMMSS>-<4 hex>, unchanged from O2
            ├── progress.json
            ├── raw-prompt.md  clarified-spec.md  spec.md
            ├── sprint-N-*.json  sprint-N-base-commit.txt
            ├── trace/                    # T1 structured run trace
            └── telemetry/                # O3, opt-in
```

The per-run directory's *internal* layout is unchanged from O2 — only its parent moves from `<projectRoot>/.gan-state/runs/` to `<store-root>/<repo-key>/runs/`. **Only run *data* relocates.** The generator worktree stays in the project tree: it is the user's own worktree in case 1a, or a gan-created run-scoped worktree at `<project>/.gan-state/runs/<run-id>/worktree/` in cases 1b/1c (see §2). The central run directory never contains a worktree — that keeps the high-frequency code writes inside the workspace (§3).

**Store root resolution**, highest priority first:
1. `GAN_RUNS_DATA` environment variable (single-run override; testing / CI).
2. The path recorded at install time (see §5).
3. Default `~/.gan-runs-data`.

**Repo keying.** `<repo-key>` is derived from the repo's **main-worktree root** — the parent of `git rev-parse --git-common-dir`, canonicalized per F1's determinism pins (`fs.realpathSync.native` + trailing-slash strip + case-insensitive compare). All linked worktrees of a repo share one `git-common-dir`, so they resolve to the **same key** — that is what makes `--recover` work repo-wide (§4). The key is `<basename>-<hash>`, where `basename` is the main-worktree directory name (for human browsability) and `hash` is the first 12 lowercase hex of the SHA-256 of the canonical main-worktree path. Path-based (not first-commit-SHA) keeps determinism and matches O2's existing path-anchored recovery model; moving a repo on disk yields a new key (acceptable pre-1.0 — O2 already refuses cross-path recovery per its Decision 3A).

`.gan-state/` does **not** disappear: zone-2 **module state** (`.gan-state/modules/`, e.g. the Docker port-registry) stays project-local per F1, and zone-3 cache (`.gan-cache/`) is unchanged. Only `runs/` relocates. (Module-state durability across worktree removal is a separate concern, explicitly out of scope — see "What F7 does not do".)

### 2. Worktree-aware execution

At run start the orchestrator derives a **task slug** from the run subject (the spec name in spec-dir mode, or a slugified prompt in prompt mode; deterministic), then resolves the workspace by this three-way rule:

- **(1a) Reuse in place.** The current branch's name matches the task slug **and** the current directory is a worktree dedicated to that branch → the orchestrator uses the current worktree and branch as-is. No new worktree is created; the generator writes here. *This is the only case where the generator writes into a user-owned worktree — the engineer opted in by naming the worktree after the task.*
- **(1b) Wrap the matching branch.** The current branch matches the task slug but the current directory is **not** a worktree dedicated to it (e.g. the task branch is checked out in the main checkout) → the orchestrator creates a worktree for that existing branch.
- **(1c) Create branch + worktree.** Neither matches → the orchestrator creates a new branch named after the task, checked out in a run-scoped worktree (see below).

"Matches" is exact equality between the task slug and the slugified terminal component of the current branch name (e.g. branch `feature/add-export` slugifies to `add-export`). The comparison is deterministic and case-insensitive.

**Worktrees created by gan are run-scoped and live in the project tree**, exactly as the current orchestrator places them: `<project>/.gan-state/runs/<run-id>/worktree/`, gitignored, ephemeral, removed by run cleanup (§4). This keeps the generator's code writes inside the workspace boundary — no permission prompts (§3) — and reuses proven, shipped worktree mechanics. The durable, task-named artifact is the **branch**: case 1c creates a branch named after the task and checks the run-scoped worktree out to it; case 1b reuses the matching branch the same way. What survives a worktree's removal is the run *data*, which lives in the central store, not the worktree (§1).

**Override.** A `--new-worktree` flag forces case-1c behavior (fresh task-named branch + worktree) even when the current context would match 1a/1b — for engineers who want gan isolated from their current working tree. Cataloged in `runtime-knobs.md`.

`progress.json` records the resolved workspace **at run start** so recovery, confinement (§3), and cleanup (§4) can find it: `workspace.worktreePath` (canonical absolute path — the **recovery anchor**, §4), `workspace.branch`, and `workspace.createdByGan` (boolean — true only for 1b/1c).

### 3. Confinement-hook supersession (over H1)

H1's framework-owned `gan-confine.sh` derives its allowed zones from the project root: the worktree at `.gan-state/runs/${GAN_RUN_ID}/worktree` and per-sprint artifacts under `.gan-state/runs/${GAN_RUN_ID}/`. Under F7 the **artifacts move to the central store**, and the **worktree is no longer always at that fixed sub-path** (it is the user's own worktree in case 1a). So the hook can no longer construct its zones from the project root alone. The orchestrator exports two absolute paths alongside `GAN_RUN_ID`:

- `GAN_WORKTREE` — the resolved worktree: the user's worktree in case 1a, or `<project>/.gan-state/runs/<run-id>/worktree/` in 1b/1c.
- `GAN_RUN_DIR` — the central-store run directory (`<store-root>/<repo-key>/runs/<run-id>/`) holding the artifacts, `trace/`, and `telemetry/`.

The hook stays a **pure deny-gate, exactly as H1 shipped** — allow (`exit 0`) writes under `$GAN_WORKTREE` and the declared artifact subpaths under `$GAN_RUN_DIR`; deny (exit non-zero) everything else (`~/.claude/`, `.claude/gan/`, `.gan-cache/`, `.gan-state/modules/`, the rest of the home directory); no-op when `GAN_RUN_ID` is unset. It is **not** elevated to emit `allow` permission-decisions.

**Why there is no prompt storm without elevating the hook.** A deny-gate's `exit 0` only stops the hook from *blocking*; it defers the prompt decision to Claude Code's normal flow, which trusts the workspace (`CLAUDE_PROJECT_DIR` / cwd) and would prompt on writes outside it. F7 keeps both write targets prompt-free without changing the hook's posture:

- **The worktree is always in-workspace.** In case 1a it *is* the cwd; in 1b/1c it is under the project root. Either way the generator's high-frequency code writes never leave the workspace — no prompts, no additional-directory registration needed.
- **The central store is granted once, at install.** Because the store is a single fixed framework-owned location, `install.sh` writes persistent `permissions.allow` rules plus an `additionalDirectories` entry for `<store-root>` into the user-tier `~/.claude/settings.json` (§5). Every Claude instance inherits the grant, so writes to the central run dir never prompt — the hook does not have to authorize them per-write.

The H1-shipped template (`scripts/hooks/gan-confine.sh.template`) and `gan hooks status` output are rewritten in place to read `$GAN_WORKTREE` / `$GAN_RUN_DIR` (`M` rows in `retirements.md`); `GAN_WORKTREE` and `GAN_RUN_DIR` are cataloged in `runtime-knobs.md`.

### 4. Recovery and serialization (over O2)

F7 redefines the "project root" O2 uses for both anchoring and recovery keying: it is now the **main-worktree root** (git-common-dir parent), not the current worktree toplevel. Consequences:

- **Discoverable repo-wide (2a), resumable only at the origin worktree.** `--list-recoverable` and `--cleanup` enumerate `<store-root>/<repo-key>/runs/`, so every run of the repo is *visible* from any worktree — the central, repo-keyed store is what makes this work, and `progress.json.projectRoot` (the canonical main-worktree root) is what O2's cross-project refusal compares against. **Resuming is different.** A run's working tree, branch, and base commit live in one specific worktree — the engineer's own in case 1a, the gan-created `.gan-state/runs/<id>/worktree/` under its origin checkout in 1b/1c — so a run is *resumable only there*. `--recover` reads `workspace.worktreePath` and **refuses** when the current invocation is not that worktree, exiting non-zero with the path: `Run <id> was executed in worktree <path> (branch <branch>); recover it from there.` If the recorded worktree no longer exists (it was removed), recovery refuses with the same path plus guidance to recreate it — the run *data* is safe in the central store, but the worktree it must resume into is gone.
- **Serialization (2b).** O2's one-active-run-per-project lock is preserved, re-anchored to the central store: the exclusive `flock` is taken on `<store-root>/<repo-key>/run.lock`. One active `/gan` run per repo, across all its worktrees — concurrent invocations from different worktrees of the same repo hard-refuse, exactly as O2 specifies for one project root.
- **`--cleanup`** deletes the central-store run directory and, when `workspace.createdByGan` is true, the run-scoped worktree at `.gan-state/runs/<run-id>/worktree/` and its run branch — symmetric to the current model. A user-owned worktree (case 1a) is never touched; only its central run *data* is removed. Because data lives centrally, removing a worktree by any means no longer loses run data.

These edits land in O2's spec (unimplemented, therefore editable) in F7's PR; O2's full implementation (later in the v1.0 order) builds on F7's resolved store + worktree model.

### 5. Install-time configuration

`install.sh` sets the store root at install time: a `--runs-dir=<path>` flag and, in interactive installs, a prompt defaulting to `~/.gan-runs-data`. It then does two writes for that path, both through `install.sh`'s STATE_LOG (rolled back on partial failure, removed by `--uninstall`) — the same atomic-write discipline H1 and I2 use:

1. **Persist the path** to a user-tier marker (`~/.claude/gan/runs-data-dir`), read by the orchestrator at run start; `GAN_RUNS_DATA` overrides it per-run. STATE_LOG entry `runs-dir-configured:<path>`.
2. **Grant persistent read-write** to the store by merging into the user-tier `~/.claude/settings.json`: `permissions.allow` rules `Read(<store-root>/**)`, `Write(<store-root>/**)`, `Edit(<store-root>/**)`, plus a `permissions.additionalDirectories` entry for `<store-root>`. This is the once-and-for-all grant — every Claude instance that runs gan inherits it, so central-store writes never prompt (§3). It is **broad by design** (all sessions, not just gan runs) but scoped to the dedicated, low-sensitivity store directory; the deny-gate hook still confines everything else during a run. STATE_LOG entry `runs-dir-permission-granted:<path>`.

Both are additions to `install.sh`'s sequence, not edits to the shipped R2/I-series specs (same pattern H1 used to add its hook-write step). The new install flag and the settings keys are cataloged in `runtime-knobs.md`.

### What F7 does not do

- **Relocate module state.** `.gan-state/modules/` stays project-local (F1). It carries the same worktree-removal vulnerability for the Docker port-registry; relocating it is the job of its paired spec **[F8](F8-centralized-module-state-store.md)**, because module state is repo-coupled in ways run data is not (e.g. host-port allocations tied to a checkout).
- **Migrate existing `.gan-state/runs/` data.** Pre-1.0, no migration: a pre-existing project-local `.gan-state/runs/` is reported once and left for the user to delete or archive by hand.
- **Change the per-run directory's internal layout** (O2 owns it) or the trace event schema (T1 owns it). Only the storage *location* moves.
- **Support Windows.** Bash-flavored, macOS/Linux, per existing platform decisions.

## Surfaces

New runtime surfaces (canonical entries land in `runtime-knobs.md` in F7's PR; the surface-count inventory updates accordingly):

- `/gan --new-worktree` — force case 1c (fresh task-named branch + run-scoped worktree) even when 1a/1b would match.
- `install.sh --runs-dir=<path>` — set the central store root at install time.
- env `GAN_RUNS_DATA` — per-run store-root override.
- env `GAN_WORKTREE`, `GAN_RUN_DIR` — orchestrator-exported absolute paths consumed by the confinement hook.

O2's `--recover` / `--list-recoverable` / `--cleanup` / `--run-id` descriptions are updated (location text only) to reference the central store.

## Schema additions

- `progress.json` gains `workspace` (`{ worktreePath, branch, createdByGan }`) and its `projectRoot` is redefined to the canonical main-worktree root. `progress.json` is not yet a published schema document (no `schemas/progress-*.json` on disk), so no schema version bump is required; if O2's implementation publishes one, it includes these fields at v1.
- No change to `run-trace-v1.json` / `run-trace-index-v1.json` (T1) — the trace's location moves, its shape does not.

## Examples

A run started from a clean main checkout for task `add-export` (case 1c), with the default store:

```
$ /gan          # subject → task slug "add-export"; current branch "develop" ≠ task
# creates branch feature/add-export, checked out in a run-scoped worktree
#   at .gan-state/runs/20260522T180000-9c4f/worktree/
# run DATA at ~/.gan-runs-data/myapp-3f9a1c0b8e21/runs/20260522T180000-9c4f/
```

A run from inside a worktree the engineer created for the task (case 1a):

```
$ cd ../myapp-add-export && /gan   # branch "feature/add-export" matches; dedicated worktree → reuse in place
# no new worktree; the generator writes here; run DATA at ~/.gan-runs-data/myapp-3f9a1c0b8e21/runs/<new-id>/
```

Repo-wide recovery from any worktree:

```
$ /gan --list-recoverable     # run from ../myapp-add-export OR from the main checkout
# both list the same runs under ~/.gan-runs-data/myapp-3f9a1c0b8e21/runs/
```

## Acceptance criteria

### Automated checks

- A run started in a linked worktree writes its run directory under `<store-root>/<repo-key>/runs/`, not under the worktree; removing the worktree afterward leaves the run directory and its `trace/` intact.
- Two linked worktrees of the same repo resolve to the **same** `<repo-key>`; `--list-recoverable` from either lists the same runs.
- `--recover` of a run invoked from a worktree other than its recorded `workspace.worktreePath` **refuses** (non-zero) and names the correct worktree path; the same run is still **listed** by `--list-recoverable` from any worktree of the repo.
- Case 1a: current branch matches the task slug and the cwd is a dedicated worktree → no new worktree is created; `workspace.createdByGan` is false; the generator's writes land in the current worktree.
- Case 1b: matching branch, non-dedicated cwd → a worktree is created for the existing branch; `createdByGan` true.
- Case 1c: non-matching branch → a new branch named after the task, checked out in a run-scoped worktree at `.gan-state/runs/<id>/worktree/`; `createdByGan` true.
- `--new-worktree` forces 1c behavior even when the context matches 1a/1b.
- A second concurrent `/gan` invocation from a different worktree of the same repo hard-refuses on the `run.lock` under `<store-root>/<repo-key>/`.
- The confinement hook allows writes under `$GAN_WORKTREE` and the declared subpaths of `$GAN_RUN_DIR`, denies `~/.claude/`, `.gan-state/modules/`, and paths outside both; no-op when `GAN_RUN_ID` is unset.
- A run completes its in-bounds writes **without an interactive permission prompt**: worktree writes are in-workspace (the worktree is the cwd in 1a, under the project root in 1b/1c), and central-store writes are covered by the install-time settings grant — *not* by the hook, which stays a deny-gate (`exit 0` for in-bounds, non-zero for escapes).
- `install.sh --runs-dir=<path>` persists the path to the marker; a run with no `GAN_RUNS_DATA` writes under it; `GAN_RUNS_DATA` overrides it. `--uninstall` removes the marker; partial-failure rollback removes it.
- After `install.sh --runs-dir=<path>`, `~/.claude/settings.json` contains `permissions.allow` rules (`Read`/`Write`/`Edit`) and an `additionalDirectories` entry for the store root; `--uninstall` removes both; partial-failure rollback removes both.
- `--cleanup` of a run removes its central-store directory and, for a gan-created run-scoped worktree (1b/1c), the worktree and run branch; a user-owned (1a) worktree is left untouched.

### Manual review checks

- The roadmap's F7 entry names its supersession of F1/T1/H1, and T1's and H1's shipped roadmap lines point to F7 (F1 has no individual order entry; F7's entry is its cross-reference). None of those shipped specs is edited.
- `retirements.md` gains rows for the rewritten `gan-confine.sh.template` and `gan hooks status` output (`M`), and for any code path that constructed `.gan-state/runs/` run paths.
- `runtime-knobs.md` lists `--new-worktree`, `install.sh --runs-dir`, `GAN_RUNS_DATA`, `GAN_WORKTREE`, `GAN_RUN_DIR`; the surface-count inventory total is updated.
- New user-facing strings obey the F4 prose-discipline rule.
- Release notes name the no-migration step for users with a pre-existing project-local `.gan-state/runs/`.

## Dependencies

- **F1** — zone contract (shipped). F7 supersedes F1's zone-2 run-data location; F1 is not edited.
- **T1** — structured run trace (shipped). F7 relocates the trace directory; T1's schema and event model are unchanged and not edited.
- **H1** — confinement hook (shipped). F7 supersedes the hook's path construction and rewrites the template + `gan hooks status`; H1 is not edited.
- **O2** — recovery (unimplemented, edited here). projectRoot redefined to the main-worktree root; lock and run enumeration re-anchored to the central store.
- **O3** — telemetry semantics (unimplemented, edited here). Telemetry capture paths move with the run directory.
- **H2** — draft (a reconciliation note added here flagging the F7 dependency and the open control-channel-location question; the full path rework lands at H2's v1.1 implementation).
- **A1, E5, D1** — v1.0 drafts (F7-consistency notes added here): their incidental run-path references — A1's halt-message trace path, E5's `clarified-spec.md`/`raw-prompt.md` output paths, D1's run enumeration — now resolve under the central store. Each spec's own implementation lands after F7 and renders the central-store paths.
- **A2 (v1.1), E6 (later)** — drafts that also reference `.gan-state/runs/` paths but are out of v1.0 scope; not edited now, reconciled with F7 when those specs are worked.
- **T4** — draft; no filesystem-path coupling (it adds a `runConfiguration` trace event class only), so no change is needed.
- **install.sh / R2 / I-series** — shipped; F7 adds an install step and flag without editing those specs (same pattern as H1).

## Bite-size note

Sprintable as:

1. (one sprint) Store resolution + repo keying: store-root precedence, `<repo-key>` derivation from git-common-dir, run-directory relocation. Determinism tests.
2. (one sprint) Worktree-aware execution: task-slug derivation, the 1a/1b/1c resolver, `--new-worktree`, task-named worktree creation, `workspace` fields in `progress.json`.
3. (one sprint) Confinement-hook supersession: orchestrator exports `GAN_WORKTREE` / `GAN_RUN_DIR`; rewrite `gan-confine.sh.template` and `gan hooks status`; behavioral path tests.
4. (one sprint) Recovery + serialization: O2 spec edits, repo-wide enumeration, lock re-anchoring, cleanup worktree handling.
5. (one sprint) Install-time config: `install.sh --runs-dir` + prompt, marker persistence, STATE_LOG + rollback + uninstall.
6. (one sprint) Implementation-time docs: add the `runtime-knobs.md` surfaces (`--new-worktree`, `--runs-dir`, `GAN_RUNS_DATA`, `GAN_WORKTREE`, `GAN_RUN_DIR`) + surface-count bump; add the `retirements.md` rows; flip F7's roadmap entry to ✅. (The dependent spec-prose edits — O2 / O3 / H2 / A1 / E5 / D1 — already landed with this spec, not the implementation; T4 needed none.)

Slices 1–2 land first and in order; 3–5 depend on 1–2 and can parallelize; slice 6 lands with F7's implementation PR.
