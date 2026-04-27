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

No auto-discovery. No inference. The user tells `/gan` exactly what to read.

## Acceptance criteria

- A project overlay listing three `additionalContext` files causes those files' contents to appear in the planner's (or proposer's) context at run time.
- A missing listed file produces a warning in the run log but does not abort.
- Exceeding the size cap produces a hard error naming the offending file.
- Absent overlay, or overlay without these keys, produces no change in behavior.

## Dependencies

- C3 (overlay schema)
- F2, R1 (the API reads the files and exposes them via `getResolvedConfig()`)
- F3 (the `additionalContext.path_resolves` cross-file invariant catalogued there fires for missing files)

## Note on E1 dependency

Acceptance criterion 1 ("files' contents appear in the planner's / proposer's context at run time") requires those agents to read context from `getResolvedConfig().additionalContext` rather than from raw filesystem lookups. That coordination is finalised by E1 (agent prompt rewrite). The splice-point handling and the API-side file reading can land before E1; the round-trip into agent prompts depends on E1.

## Bite-size note

Splittable as: schema + API-side file reading + cap enforcement first → planner consumption (after E1's planner rewrite) → proposer consumption (after E1's proposer rewrite). Each agent's consumption is its own sprint slice within E1.
