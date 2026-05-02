# F1 — gan filesystem layout

## Problem

Multiple specs and external documents write files into project-level directories with opposing lifecycles, and no spec defines the boundaries:

- `/gan` orchestration uses `.gan/` for per-run state (progress.json, contracts, worktree metadata) that is **archived or deleted on teardown** (O2-recovery.md).
- M1-modules-architecture.md stores `.gan/port-registry.json` as a **durable** cross-run registry mapping worktree → host port → container. Archived-on-teardown and durable are incompatible lifecycles in the same directory; the registry is either lost (after `/gan` archives `.gan/`) or misread as stale orchestration state (triggering a spurious recovery prompt).
- Overlays (spec C3) and tier-2 stack files (spec C5) live in `.claude/gan/` — user-authored configuration, committed to the repo.
- Per-worktree build caches use `<worktree>/.gan-cache/` — ephemeral, safe to delete (consumed by stack `cacheEnv` declarations per C1).

As we add more stateful tools (Python venv tracking, DB seed registries, Terraform state locators, …), every new tool will collide with one of these directories unless the layout is formalised. This spec pins the boundaries before that happens.

## Proposed change

Three zones per project, following standard POSIX filesystem conventions. Each zone has a **single owner lifecycle**; no zone is shared between opposing lifecycles. (The framework's v1 platform priority — macOS primary, Linux best-effort, Windows out-of-scope — is documented under "Platform priority" in `PROJECT_CONTEXT.md`; the zone layout below is portable across both supported platforms.)

```
<project>/
  .claude/gan/                    # ZONE 1 — config  (like /etc)
    project.md                    # overlay (spec C3)
    stacks/                       # tier-2 stack overrides (spec C5)
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
- **Authorship:** hand-edited primarily. Programmatic writes are permitted **only** through the channels enumerated below; no other code path may mutate this zone.
- **Lifecycle:** persists forever. **Committed to the repo.**
- **Git:** tracked.
- **Contents:** `project.md`, `stacks/<name>.md`, `modules/<module>.yaml` (e.g. `modules/docker.yaml` declaring `containerPattern`, `fallbackPort`).

**Sanctioned write channels.** Zone 1 is mutable through two and only two paths:

1. **Configuration API write functions** (per F2): `setOverlayField`, `updateStackField`, `appendToStackField`, `removeFromStackField`, `registerModule` (which updates module manifest entries the API tracks). Agents and the CLI both reach these through R1's MCP server. Every such write is validated against schemas + cross-file invariants before persisting; failures return structured errors and persist nothing. Writes are atomic (temp-file + rename) and the API is the single writer for its own files.
2. **User-invoked CLI commands** (per R3): `gan stacks new <name>`, `gan stack update <name> <field> <value>`, `gan config set <path> <value>`, `gan migrate-overlays --to=<schemaVersion>`. These are deliberate, terminal-initiated user actions. Some (like `gan stack update`) route internally through the API write functions above; others (like `gan migrate-overlays`, which leaves a `.claude/gan/.migration-backup-<timestamp>/`) are bespoke. Both subgroups land here.

What is **forbidden**: silent / background / automatic writes. No agent, orchestrator, or module may write to zone 1 outside of the two channels above. In particular, no module's runtime hook may decide to "improve" a user's stack file or overlay; if a module wants to suggest a config change, the agent surfaces it as a recommendation and the user invokes a CLI command to apply.

The earlier wording "never write at run time" was overstated and contradicted F2's runtime API writes. The actual invariant is: zone 1 mutations happen only through validated, sanctioned channels — never opaquely.

### Zone 2: `.gan-state/` — durable state

- **Owner:** `/gan` skill and individual modules.
- **Authorship:** written by `/gan` (under `runs/<run-id>/`) and by modules (under `modules/<module>/`). Never hand-edited.
- **Lifecycle:** persists across runs. Per-run subdirectories under `runs/<run-id>/` are archived or deleted on teardown per O2-recovery.md; `modules/<module>/` subdirectories are **never touched by `/gan`** — only the owning module may write or prune them.
- **Git:** ignored (`.gitignore: .gan-state/`).
- **Contents:** `runs/<run-id>/progress.json` and friends (what today's `.gan/` contains); `modules/docker/port-registry.json`; future stateful-tool outputs.

### Zone 3: `.gan-cache/` — ephemeral cache

- **Owner:** the skill orchestrator and build tools.
- **Authorship:** auto-populated by build tools via `cacheEnv` (spec C1); contents are **fully regenerable**.
- **Lifecycle:** safe to delete at any time without correctness loss. Per-worktree subdirectories are removed when the worktree is torn down.
- **Git:** ignored (`.gitignore: .gan-cache/`).
- **Contents:** per-worktree build caches (Gradle user home, pnpm store, etc.).

## Replacing today's `.gan/`

`.gan/` is retired as a directory. Its current contents map to the new zones:

- `.gan/progress.json`, `.gan/contracts/`, `.gan/telemetry/` → `.gan-state/runs/<run-id>/…`.
- `.gan/port-registry.json` (M1-modules-architecture.md) → `.gan-state/modules/docker/port-registry.json`.
- Any `.gan/` content that is actually config (none today, but guard the case) → `.claude/gan/`.

`O2-recovery.md`'s archive path changes from `.gan/` to `.gan-state/runs/<run-id>/`. The recover flow must never touch `.gan-state/modules/`, preventing the current collision class entirely.

ClaudeAgents is pre-1.0; there is no migration path for stale `.gan/` directories. A pre-existing `.gan/` on first run after this ships is treated as a hard error with instructions to delete it manually. Users wanting to preserve run state from before this spec should archive it themselves.

**Retirement.** F1 introduces the new zones; the actual retirement of orchestrator code that writes to `.gan/` happens at E1 (the agent-rewrite cutover, per the roadmap's Retirement table). When E1 lands, every reference to `.gan/` in the codebase dies in the same PR. F1's contribution to the retirement is the zone contract; E1's contribution is the deletion of the code that violated it.

## Rules

- A new tool or module that needs persistent per-project data declares a path under `.gan-state/modules/<name>/`. It must not use `.claude/gan/` (that is for user-authored config only) and must not use `.gan-cache/` (contents must be regenerable).
- User-authored configuration for a module lives at `.claude/gan/modules/<name>.yaml`. Modules read this at load time; they never write to it.
- `/gan` per-run state lives under `.gan-state/runs/<run-id>/`. The previous `.gan/` top-level layout is retired.
- Any spec or module that wants to introduce a new top-level directory under the project root for gan-related data must update this spec first. This is the single authority for filesystem layout.

## Acceptance criteria

- `/gan` on a project with a pre-existing top-level `.gan/` halts with a hard error instructing the user to delete or rename the directory before re-running. No auto-migration.
- A Docker module writing `.gan-state/modules/docker/port-registry.json` is never touched by `gan-recover`'s archive or delete steps — verified by a regression test that runs the recovery flow on a project with an active registry and asserts the registry file is unchanged.
- `O2-recovery.md`'s archive step only ever sees paths under `.gan-state/runs/<run-id>/`.
- E3's normalisation rules (`tests/fixtures/normalise-rules.json`, consumed by `scripts/evaluator-pipeline-check/`) include path-prefix stripping for `.gan-state/runs/<run-id>/` and `.gan-cache/<worktree-id>/`. F1's contribution is the zone names; the normalisation rule itself lands in E3 and is verified when E3 ships.
- A project without any of the three zones on disk behaves correctly: zones are created lazily by their owners at first write.
- `.gitignore` templates in fixture projects (`tests/fixtures/stacks/*/`) list `.gan-state/` and `.gan-cache/` but not `.claude/gan/`.

## Dependencies

None. Prerequisite for the M1-modules-architecture.md port-registry relocation and for any future stateful-module work. Specs C3 (overlay), C5 (stack resolution), R1 (server reads/writes per these zones), and O2-recovery.md reference this spec for directory ownership.

## Value / effort

- **Value**: high. Resolves the `.gan/` collision between MODULES and the `/gan` skill, and prevents the same class of collision from recurring as new stateful tools land.
- **Effort**: small. The three zones are mostly renames of things that already exist; the skill emits a hard error on pre-existing `.gan/` rather than migrating it.
