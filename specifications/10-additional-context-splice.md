# 10 — additionalContext splice point

## Problem

Projects often maintain living documentation — architecture notes, coding standards, PR checklists, knowledge bases — that the planner and contract-proposer would benefit from reading. But ClaudeAgents cannot auto-discover or assume anything about these files, since it must stay generic. Hardcoding filenames like `ARCHITECTURE.md` or `PROJECT_CONTEXT.md` would bake in another tool's conventions.

## Proposed change

Add two splice points to the project overlay (spec 09) that let the user **explicitly point** at documentation they want the agents to read:

```
## planner.additionalContext
Files the planner reads before producing the spec. Paths relative to the
target directory.

- docs/architecture.md
- docs/conventions/coding-standards.md

## proposer.additionalContext
Files the contract-proposer reads before drafting criteria.

- docs/pr-checklist.md
```

Semantics:

- Each listed file is read verbatim and included in the agent's context when it starts its task.
- Missing files are reported as a warning (not a hard failure) — documentation moves around; a stale path should not block a run.
- Files are read once per run. There is no caching across runs — the content may change.
- The lists are capped (e.g. 20 files, 200 KB total) to keep agent context bounded. Excess triggers an error with a clear message.

No auto-discovery. No inference. The user tells `/gan` exactly what to read.

## Acceptance criteria

- A project overlay listing three `additionalContext` files causes those files' contents to appear in the planner's (or proposer's) context at run time.
- A missing listed file produces a warning in the run log but does not abort.
- Exceeding the size cap produces a hard error naming the offending file.
- Absent overlay, or overlay without these keys, produces no change in behavior.

## Dependencies

- 09 (overlay schema).

## Value / effort

- **Value**: high. This is the escape hatch that lets rich setups (like PROJECT_CONTEXT.md pipelines, knowledge-file conventions, company style guides) feed `/gan` without ClaudeAgents knowing they exist. Without it, users either fork agents or settle for generic output.
- **Effort**: small once 09 is in — it's two new keys and a file-reading step in two agents.
