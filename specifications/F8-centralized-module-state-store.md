# F8 — Centralized repo-keyed module-state store

## Problem

[F1](F1-filesystem-layout.md)'s zone 2 holds durable cross-run **module state** under `<projectRoot>/.gan-state/modules/<module>/` — notably [M2](M2-docker-module.md)'s Docker `port-registry.json`, which maps worktree → host port → container. Like run data (the subject of [F7](F7-central-run-data-store-and-worktree-execution.md)), the project root resolves to `git rev-parse --show-toplevel` — the current worktree's directory — and the tree is gitignored. Two failures follow, and the first is worse than the run-data case:

1. **Latent correctness bug — M2's cross-worktree guarantee silently does not hold.** M2 promises that two `/gan` runs in *different worktrees of the same project* will not collide on host ports, "because PortRegistry refuses duplicates." That promise assumes **one shared registry**. With the registry anchored per-worktree, worktree A and worktree B keep *separate* `port-registry.json` files, each blind to the other's allocations — so both can hand out host port 8080 and the second container fails to bind. The guarantee M2 advertises is broken today the moment a second worktree exists.
2. **Durability footgun (same class as F7).** `git worktree remove` deletes that worktree's `.gan-state/modules/`, losing the registry and orphaning whatever ports/containers it tracked.

F7 relocated run data but **explicitly deferred** module state, noting it is repo-coupled differently — host-port allocations are per-checkout. F8 resolves that: module state belongs in a single **repo-wide** store so the registry coordinates allocations across all worktrees *and* survives any one worktree's removal. Centralizing it doesn't just fix the footgun — it makes M2's stated guarantee true for the first time.

F8 reuses F7's `<repo-key>` derivation but keeps module state in a **separate store from run data** — they have different writers, access paths, and permission needs (see §4). F8 revises decisions that shipped in **F1** (zone-2 module-state location), **M1** (the registry's durable-cross-run home), **M2** (the Docker registry path), and **R1** (the config server's module-state path resolution). Those specs are immutable; F8 supersedes the relevant decisions and the roadmap cross-references F8 from their entries. F8 **depends on F7** and ships in the same PR.

## Proposed change

### 1. Relocate to a separate, repo-keyed module-state store

Module state moves from `<projectRoot>/.gan-state/modules/<module>/` to its **own** store, kept deliberately separate from F7's run-data store:

```
~/.gan-module-state/                # default root; install-configurable (separate from ~/.gan-runs-data)
└── <repo-key>/                      # F7's repo-key derivation, reused
    └── docker/
        └── port-registry.json       # M2 registry, now shared repo-wide
```

`<store-root>` resolves highest-priority-first: `GAN_MODULE_STATE` env (override; testing/CI) → install-time marker (§5) → default `~/.gan-module-state/`. `<repo-key>` is **F7's** key — `<basename>-<hash>` of the canonical main-worktree root (parent of `git rev-parse --git-common-dir`) — reused verbatim so all worktrees of a repo resolve to one tree. One module-state tree per repo, **shared by all its worktrees**.

Run data and module state stay in separate roots (`~/.gan-runs-data/` vs `~/.gan-module-state/`) because they are genuinely different artifacts: run data is per-run, agent-written, and cleaned by `--cleanup`; module state is durable cross-run, server-written, and never cleaned by a run. The permission and lifecycle treatment differs accordingly (§4, §6).

### 2. Repo-wide coordination — the correctness fix

Because the registry is now a single shared file per repo, M2's `PortRegistry` sees **every** worktree's allocation, and its existing duplicate-refusal actually prevents cross-worktree collisions. Entries stay keyed by worktree path, so each worktree still gets a distinct port and container name (M2's `ContainerNaming` is already deterministic on worktree path). No change to M2's `register` / `lookup` / `release` API or the registry JSON shape — only *where the file lives* and *that it is shared*. This is what makes M2's cross-worktree non-collision guarantee hold.

This matters even though F7 serializes runs one-at-a-time per repo: the collision it prevents is not between *concurrent runs* but between *coexisting containers*. A worktree's dev container outlives the run that started it (M2 remembers each worktree's port "across runs and shell sessions"), so a later, sequential run in a second worktree must still avoid the ports the first worktree's still-running container holds. A shared registry lets it; separate per-worktree registries cannot.

### 3. Stale-entry reclamation

A shared registry now outlives the individual worktrees it tracks, so it accumulates entries for worktrees that have been removed. The owning module reclaims them: **on module load, entries whose worktree path no longer exists are pruned and their host ports freed** — M2's existing "release the entry (worktree gone)" path, now operating repo-wide instead of per-worktree. Orphaned-container teardown remains M2's concern, unchanged.

### 4. Server-managed — no confinement-hook and no permission-grant involvement

Module state is written via `setModuleState()` and read via `getModuleState()` through R1's Configuration MCP server. Per R1 and M2, **only the server process writes the file** — directly, via temp-file + rename — and all reads serialise through the server. This has two consequences that distinguish F8 from F7:

- **No permission grant needed.** F7's run store needs a `permissions.allow` grant because *agents* write run artifacts with the Write/Edit tools. The module store is touched only by the config-server *process* (not a Claude-tool file op) and by `setModuleState`/`getModuleState` MCP calls (not path operations). No Claude-tool file operation reaches it, so F8 adds **no** `permissions.allow` rule and **no** `additionalDirectories` entry — the separate store is invisible to Claude Code's permission layer.
- **No confinement-hook change.** The module store is outside both `$GAN_WORKTREE` and `$GAN_RUN_DIR`, so F7's deny-gate already refuses a sprint agent's direct file write there — preserving F1's "module state is module-owned, never sprint-written" rule for free. The server's own writes are not Claude-tool calls, so the hook never sees them.

### 5. Resolution owner and install-time configuration

R1's config server — the implementer of `setModuleState` / `getModuleState` — resolves the module-state path to `<module-state-root>/<repo-key>/<module>/` using the **main-worktree root**, not the invoking worktree. R1 is shipped; F8 supersedes its module-state path resolution via the new-spec mechanism (R1 is not edited; the roadmap cross-references F8; the code change lands an `M` row in `retirements.md` at F8's implementation).

`install.sh` sets the module-state root, in parity with F7's `--runs-dir`: a `--module-state-dir=<path>` flag and an interactive prompt defaulting to `~/.gan-module-state/`. The chosen path is persisted to a user-tier marker (`~/.claude/gan/module-state-dir`), read by the config server; `GAN_MODULE_STATE` overrides it. The write goes through `install.sh`'s STATE_LOG (`module-state-dir-configured:<path>`), rolled back on partial failure and removed by `--uninstall`. **Unlike F7, there is no settings-grant write** (§4) — only the marker.

### 6. Lifecycle

Module state is durable cross-run and **never touched by `/gan` run cleanup or O2 recovery** — F1's zone-2 ownership rule, preserved at the new location. It lives in its own store, entirely separate from `<repo-key>/runs/`, so F7's `--cleanup` cannot reach it; only the owning module writes or prunes it.

### What F8 does not do

- **Change M2's API or registry shape.** `PortRegistry` / `PortDiscovery` / `ContainerNaming` and `port-registry.json`'s JSON are unchanged — only its location and repo-wide sharing.
- **Migrate existing `.gan-state/modules/` data.** Pre-1.0, no migration: a pre-existing project-local module store is reported once and left for the user to delete by hand.
- **Add operator surfaces.** Reclamation is automatic on module load. A manual `gan modules prune` is a possible future convenience, not promised here.
- **Support Windows.** macOS/Linux, per existing platform decisions.

## Surfaces

New runtime surfaces (canonical entries land in `runtime-knobs.md` in the implementation PR):

- `install.sh --module-state-dir=<path>` — set the module-state store root (parity with F7's `--runs-dir`).
- env `GAN_MODULE_STATE` — per-invocation module-state-root override.

No `/gan` or `gan` CLI surface, no confinement-hook surface, and no `permissions.*` settings keys (§4).

## Schema additions

None. The `port-registry.json` shape is M2's and unchanged; the only structural change is the `<module-state-root>/<repo-key>/<module>/` location.

## Examples

Two worktrees of the same repo, both using the Docker module:

```
# worktree A (../myapp-feature-x): module starts a container, registers host port 8080
# worktree B (../myapp-feature-y): PortRegistry reads the SAME shared registry,
#   sees 8080 taken, allocates 8081 — no collision
# registry: ~/.gan-module-state/myapp-3f9a1c0b8e21/docker/port-registry.json
```

Worktree removal no longer loses the registry:

```
$ git worktree remove ../myapp-feature-x
# the shared registry survives; on next module load, the entry for the removed
# worktree is pruned and host port 8080 is freed for reuse
```

## Acceptance criteria

### Automated checks

- Two worktrees of the same repo resolve to the **same** `<module-state-root>/<repo-key>/docker/port-registry.json`; the second worktree's `PortRegistry` sees the first's allocation and picks a different host port — a regression test for M2's cross-worktree non-collision guarantee, which fails under the pre-F8 per-worktree layout.
- Removing a worktree leaves the module store and its registry byte-intact.
- On module load, a registry entry whose worktree path no longer exists is pruned and its port freed.
- A sprint agent's direct file write under `<module-state-root>/<repo-key>/` is **denied** by the confinement hook; a `setModuleState("docker", "port-registry", …)` API call **succeeds** (it does not pass through the hook).
- The module store appears in **no** `~/.claude/settings.json` `permissions.allow` rule or `additionalDirectories` entry (it is server-managed, §4).
- F7's run `--cleanup` and O2's recovery/cleanup never touch `<module-state-root>/<repo-key>/`.
- `install.sh --module-state-dir=<path>` persists the marker; the config server resolves under it; `GAN_MODULE_STATE` overrides it; `--uninstall` and partial-failure rollback remove the marker.

### Manual review checks

- The roadmap cross-references F8 from F1/M1/M2/R1 for the relocated module-state location; none of those shipped specs is edited.
- `retirements.md` gains an `M` row for R1's module-state path-resolution code at F8's implementation.
- M2's advertised cross-worktree non-collision guarantee is verified to hold post-F8 (documented as a fixed latent bug, not new behavior).
- `runtime-knobs.md` lists `--module-state-dir` and `GAN_MODULE_STATE`; surface-count inventory updated.

## Dependencies

- **F7** — centralized run-data store + worktree-aware execution (depends; same PR). F8 reuses F7's `<repo-key>` derivation and store-root resolution *pattern*, and relies on F7's confinement-hook deny behavior to refuse sprint writes to the module store. F8 does **not** reuse F7's run store or its permission grant — module state has its own root and needs no grant (§4).
- **F1** — zone contract (shipped). F8 supersedes F1's zone-2 module-state location; F1 is not edited.
- **M1** — modules architecture (shipped). The durable-cross-run registry's home moves to the separate central store; the registry concept is unchanged; M1 is not edited.
- **M2** — Docker module (shipped). F8 makes M2's cross-worktree non-collision guarantee actually hold; M2's API and registry shape are unchanged; M2 is not edited.
- **R1** — config MCP server (shipped). `setModuleState`/`getModuleState` resolve to the separate store via the main-worktree root; R1 is not edited (superseded via the roadmap; code change is an `M` retirement row).
- **O2** — recovery (unimplemented, edited here). Recovery/cleanup never touch the relocated module store.

## Bite-size note

Sprintable as:

1. (one sprint) Config-server resolution: module-state path → `<module-state-root>/<repo-key>/<module>/` via the main-worktree root, reusing F7's `<repo-key>`; store-root resolution (`GAN_MODULE_STATE` → marker → default). Determinism tests; assert deny-by-default for sprint writes (sibling of `$GAN_RUN_DIR`; no hook change, no grant).
2. (one sprint) Repo-wide coordination + reclamation: the shared registry; prune-on-load for absent worktrees with port reclamation; the M2 cross-worktree non-collision regression test (the correctness fix).
3. (one sprint) Install + cascade: `install.sh --module-state-dir` + marker (no grant); O2 edit (recovery/cleanup never touch the module store); roadmap cross-refs + flip; `runtime-knobs.md` surfaces; `retirements.md` row for R1's resolution code.

Slices 1–2 land in order; slice 3 lands with the implementation PR. F8 builds on F7 within the same PR.
