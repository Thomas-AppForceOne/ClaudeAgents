# U3 — additionalContext splice point

## Problem

Projects often maintain living documentation — architecture notes, coding standards, PR checklists, knowledge bases — that the planner and contract-proposer would benefit from reading. But ClaudeAgents cannot auto-discover or assume anything about these files, since it must stay generic. Hardcoding filenames like `ARCHITECTURE.md` or `PROJECT_CONTEXT.md` would bake in another tool's conventions.

## Proposed change

Add two splice points to the project overlay (spec C3) that let the user **explicitly point** at documentation they want the agents to read. The values live inside the overlay's YAML body block per C3's parse contract:

```yaml
planner:
  additionalContext:
    - docs/architecture.md
    - docs/conventions/coding-standards.md

proposer:
  additionalContext:
    - docs/pr-checklist.md
```

Both splice points are project-only (per C3's user-overlay rule); declaring them in the user overlay is a hard error.

Semantics:

- The Configuration API (F2) reads each listed file at `validateAll()` time and includes its contents in the resolved config. Agents receive the contents through `getResolvedConfig()`.
- Missing files are reported as a **warning** (not a hard failure) — documentation moves around; a stale path should not block a run. The warning surfaces in the validation report and in O1's startup log / `--print-config` output.
- Files are read once per run. There is no caching across runs — the content may change.
- The lists are capped: **20 files maximum per splice point, 200 KB total per splice point** (sum of all file sizes for that list). The API's validation pipeline enforces both caps at `validateAll()` time, before any agent runs. Exceeding either cap is a hard error naming the splice point, the file count or byte total, and the offending file (for per-file issues). Agents never see a partial list; either the full list loads or the run halts.
- **Paths must not escape the project root.** Every path is resolved relative to the project root and verified to land inside it. Symlinks pointing outside the root are treated as escapes. Failures produce a `PathEscape` structured error per F4's path-resolution rules.

No auto-discovery. No inference. The user tells `/gan` exactly what to read.

**`additionalContext` is not stack-scoped in v1.** A polyglot project (e.g. Android + Python) lists planner additionalContext globally; there is no syntax for "load `architecture.md` only when planning for the Android stack." For most projects this is fine — context files are usually project-wide. As polyglot fixtures get richer (`tests/fixtures/stacks/polyglot-android-node/` already exists), per-stack additionalContext may be worth adding. Out of scope for v1; flagged for a future revision of this spec or a successor splice point.

## Acceptance criteria

- A project overlay listing three `additionalContext` files causes those files' contents to appear in the planner's (or proposer's) context at run time.
- A missing listed file produces a warning in the run log but does not abort.
- Exceeding the size cap produces a hard error naming the offending file.
- Absent overlay, or overlay without these keys, produces no change in behavior.

## Dependencies

- C3 (overlay schema)
- F2, R1 (the API reads the files and exposes them via `getResolvedConfig()`)
- F3 (the `additionalContext.path_resolves` cross-file invariant catalogued there fires for missing files)

## Phase placement and E1 dependency

This spec ships as a single Phase 6 unit per the roadmap. The implementation, however, has natural sub-tasks that the R1 / E1 sprint plans may absorb earlier:

- **API-side splice-point handling and file reading** (the `additionalContext.path_resolves` invariant, cap enforcement, exposure via `getResolvedConfig().additionalContext`) is part of R1's resolver. It can land in Phase 2 as part of R1's sprint slices without authoring U3 first.
- **Planner / proposer consumption** of the resolved context — making the agents actually read `snapshot.additionalContext.{planner,proposer}` and inject the contents into their working context — depends on E1 (agent prompt rewrite).

U3 is the spec that pulls these threads together and adds the user-facing acceptance criteria. Authoring it in Phase 6 keeps the implementation honest: the user-visible promise ("the files I list show up in the agent's context") is only deliverable once E1 has landed.

## Bite-size note

Splittable as: schema + API-side file reading + cap enforcement first (R1 sprint) → planner consumption (E1 sprint slice) → proposer consumption (E1 sprint slice) → final U3 acceptance pass.
