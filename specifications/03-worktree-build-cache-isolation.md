# 03 — Worktree build-cache isolation

**Status:** Ships Phase 1 with a temporary hardcoded env-var catalog in the skill orchestrator. Post-Phase-2 the catalog is owned by the `cacheEnv` field in spec 04 (schema) and populated by individual stack files per spec 06 (extraction). This spec is not superseded — the worktree-scoping mechanism remains here; only the *list of env vars* migrates out.

## Problem

`/gan` runs in a git worktree. For build systems with a shared daemon or user-level cache (Gradle, sbt, Maven, some language servers), two worktrees on the same machine — or an interrupted run resumed while the original daemon is still up — can collide on lockfiles, daemon ports, or cached state. Symptoms: hung builds, stale class files, mysterious "file already locked" errors.

This is not Android-specific. It also hits sbt, pnpm (shared store), and any tool that uses `~/.<tool>/` as its working cache.

## Proposed change

Before any build command runs inside the worktree, set tool-specific cache/daemon environment variables to paths scoped to that worktree. All cache paths live under `.gan-cache/<worktree-id>/` — zone 3 of the filesystem layout defined in [spec 14](14-gan-filesystem-layout.md). This zone is ephemeral and safe to delete; no module or spec may use it for durable state.

**Phase 1 (pre-plugin-refactor):** the skill orchestrator holds a minimal, temporary list of the most common offenders so the fix ships immediately. Examples of the shape (not an exhaustive list; treated as an implementation detail, not as a core-owned catalog):

- `GRADLE_USER_HOME=<worktree>/.gan-cache/gradle`
- `SBT_OPTS="-Dsbt.global.base=<worktree>/.gan-cache/sbt -Dsbt.ivy.home=<worktree>/.gan-cache/ivy"`
- `MAVEN_OPTS` / `M2_HOME` equivalents
- `PNPM_HOME=<worktree>/.gan-cache/pnpm`

**Phase 2 migration (mandatory):** once the stack-plugin schema (spec 04) lands, this env-var catalog **must move out of the core** and into a `cacheEnv:` field on each stack file. The skill's job then becomes tech-agnostic: for each active stack, export that stack's declared `cacheEnv` with `<worktree>` substituted. Adding cache isolation for a new tool (Bazel, Nix, Bun, …) becomes a stack-file edit, never a core edit.

The skill sets these env vars when invoking generator and evaluator subagents. Agents inherit them naturally via their Bash tool.

Applies only to commands run from the worktree. Host-level user caches are left untouched.

## Acceptance criteria

- Running `/gan` twice concurrently on the same repo (two base branches) does not produce a Gradle daemon lock error.
- A worktree's `.gan-cache/` is removed when the worktree is torn down at the end of the run.
- Projects without a build system matching the env-var list are unaffected (no env vars set, no directories created).
- Cold-build cost is documented in the spec — the first Gradle build in a fresh cache can take 5–15 min; this is expected.

## Dependencies

None for the Phase 1 landing. Phase 2 migration of the env-var catalog into stack files depends on spec 04 (adds `cacheEnv` to the schema) and spec 06 (moves the existing entries into `stacks/gradle.md`, `stacks/web-node.md`, etc.).

## Value / effort

- **Value**: medium. Prevents a whole class of hard-to-diagnose failures; becomes more important as users run `/gan` more often.
- **Effort**: small. Environment-variable plumbing in the skill orchestrator plus a teardown step.
