# 14 — gan filesystem layout

## Problem

Multiple specs and external documents write files into project-level directories with opposing lifecycles, and no spec defines the boundaries:

- `/gan` orchestration uses `.gan/` for per-run state (progress.json, contracts, worktree metadata) that is **archived or deleted on teardown** (gan-recover.md).
- MODULES_ARCHITECTURE.md stores `.gan/port-registry.json` as a **durable** cross-run registry mapping worktree → host port → container. Archived-on-teardown and durable are incompatible lifecycles in the same directory; the registry is either lost (after `/gan` archives `.gan/`) or misread as stale orchestration state (triggering a spurious recovery prompt).
- Overlays (spec 09) and tier-2 stack files (spec 12) live in `.claude/gan/` — user-authored configuration, committed to the repo.
- Spec 03's per-worktree build cache uses `<worktree>/.gan-cache/` — ephemeral, safe to delete.

As we add more stateful tools (Python venv tracking, DB seed registries, Terraform state locators, …), every new tool will collide with one of these directories unless the layout is formalised. This spec pins the boundaries before that happens.

## Proposed change

Three zones per project, modelled on the Linux filesystem hierarchy. Each zone has a **single owner lifecycle**; no zone is shared between opposing lifecycles.

```
<project>/
  .claude/gan/                    # ZONE 1 — config  (like /etc)
    project.md                    # overlay (spec 09)
    stacks/                       # tier-2 stack overrides (spec 12)
      <name>.md
    modules/                      # per-module project config
      <module>.yaml

  .gan-state/                     # ZONE 2 — state   (like /var/lib)
    runs/                         # per-run orchestration
      <run-id>/
        progress.json
        contracts/
        telemetry/
    modules/                      # per-module durable state
      <module>/
        *.json|yaml|db

  .gan-cache/                     # ZONE 3 — cache   (like /var/cache)
    <worktree-id>/
      gradle/
      pnpm/
      <tool>/
```

### Zone 1: `.claude/gan/` — config

- **Owner:** the user (human or another Claude agent authoring files).
- **Authorship:** hand-edited or generated once; `/gan` and its modules **never write** to this zone at run time.
- **Lifecycle:** persists forever. **Committed to the repo.**
- **Git:** tracked.
- **Contents:** `project.md`, `stacks/<name>.md`, `modules/<module>.yaml` (e.g. `modules/docker.yaml` declaring `containerPattern`, `fallbackPort`).

### Zone 2: `.gan-state/` — durable state

- **Owner:** `/gan` skill and individual modules.
- **Authorship:** written by `/gan` (under `runs/<run-id>/`) and by modules (under `modules/<module>/`). Never hand-edited.
- **Lifecycle:** persists across runs. Per-run subdirectories under `runs/<run-id>/` are archived or deleted on teardown per gan-recover.md; `modules/<module>/` subdirectories are **never touched by `/gan`** — only the owning module may write or prune them.
- **Git:** ignored (`.gitignore: .gan-state/`).
- **Contents:** `runs/<run-id>/progress.json` and friends (what today's `.gan/` contains); `modules/docker/port-registry.json`; future stateful-tool outputs.

### Zone 3: `.gan-cache/` — ephemeral cache

- **Owner:** the skill orchestrator and build tools.
- **Authorship:** auto-populated by build tools via `cacheEnv` (spec 04); contents are **fully regenerable**.
- **Lifecycle:** safe to delete at any time without correctness loss. Per-worktree subdirectories are removed when the worktree is torn down.
- **Git:** ignored (`.gitignore: .gan-cache/`).
- **Contents:** per-worktree build caches (Gradle user home, pnpm store, etc.).

## Replacing today's `.gan/`

`.gan/` is retired as a directory. Its current contents map to the new zones:

- `.gan/progress.json`, `.gan/contracts/`, `.gan/telemetry/` → `.gan-state/runs/<run-id>/…`.
- `.gan/port-registry.json` (MODULES_ARCHITECTURE.md) → `.gan-state/modules/docker/port-registry.json`.
- Any `.gan/` content that is actually config (none today, but guard the case) → `.claude/gan/`.

`gan-recover.md`'s archive path changes from `.gan/` to `.gan-state/runs/<run-id>/`. The recover flow must never touch `.gan-state/modules/`, preventing the current collision class entirely.

ClaudeAgents is pre-1.0; there is no migration path for stale `.gan/` directories. A pre-existing `.gan/` on first run after this ships is treated as a hard error with instructions to delete it manually. Users wanting to preserve run state from before this spec should archive it themselves.

## Rules

- A new tool or module that needs persistent per-project data declares a path under `.gan-state/modules/<name>/`. It must not use `.claude/gan/` (that is for user-authored config only) and must not use `.gan-cache/` (contents must be regenerable).
- User-authored configuration for a module lives at `.claude/gan/modules/<name>.yaml`. Modules read this at load time; they never write to it.
- `/gan` per-run state lives under `.gan-state/runs/<run-id>/`. The previous `.gan/` top-level layout is retired.
- Any spec or module that wants to introduce a new top-level directory under the project root for gan-related data must update this spec first. This is the single authority for filesystem layout.

## Acceptance criteria

- `/gan` on a project with a pre-existing top-level `.gan/` halts with a hard error instructing the user to delete or rename the directory before re-running. No auto-migration.
- A Docker module writing `.gan-state/modules/docker/port-registry.json` is never touched by `gan-recover`'s archive or delete steps — verified by a regression test that runs the recovery flow on a project with an active registry and asserts the registry file is unchanged.
- `gan-recover.md`'s archive step only ever sees paths under `.gan-state/runs/<run-id>/`.
- `scripts/parity-check.sh` normalisation (spec 06) is updated to strip `.gan-state/runs/<run-id>/` and `.gan-cache/<worktree-id>/` path prefixes.
- A project without any of the three zones on disk behaves correctly: zones are created lazily by their owners at first write.
- `.gitignore` templates in fixture projects (`tests/fixtures/stacks/*/`) list `.gan-state/` and `.gan-cache/` but not `.claude/gan/`.

## Dependencies

None. Prerequisite for the MODULES_ARCHITECTURE.md port-registry relocation and for any future stateful-module work. Spec 03 (cache isolation), spec 09 (overlay), spec 12 (stack resolution), and gan-recover.md reference this spec for directory ownership.

## Value / effort

- **Value**: high. Resolves the `.gan/` collision between MODULES and the `/gan` skill, and prevents the same class of collision from recurring as new stateful tools land.
- **Effort**: small. The three zones are mostly renames of things that already exist; the skill emits a hard error on pre-existing `.gan/` rather than migrating it.
