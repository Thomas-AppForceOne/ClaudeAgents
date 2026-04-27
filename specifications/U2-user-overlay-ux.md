# U2 — User overlay UX

## Problem

C4 defines the three-tier cascade and the user overlay's *schema* role within it. U2 covers the human side: what does it feel like to maintain `~/.claude/gan/config.md` over time across many projects?

User overlays differ from project overlays in audience: they are personal, not shared. The UX must:

- Make personal preferences easy to set without polluting any specific project.
- Prevent footguns where a user-level rule unexpectedly weakens or strengthens project behavior.
- Integrate with the auto-memory pipeline so an external memory system can populate the file without touching ClaudeAgents internals.

## Proposed change

### Bootstrapping

The user overlay is `~/.claude/gan/config.md`. Same parse contract as the project overlay (per C3). Missing file is a no-op; defaults apply.

A first-time user invokes `gan config set --tier=user runner.thresholdOverride 8`. R3 creates the file if absent. The resulting content:

```
---
schemaVersion: 1
---
```yaml
runner:
  thresholdOverride: 8
```
```

### What belongs here

The user overlay is the right place for:

- Personal threshold preferences.
- Always-on `evaluator.additionalChecks` the user wants regardless of project.
- Cross-project `proposer.additionalCriteria` (e.g. company-mandated security criteria the user works under everywhere).
- `generator.additionalRules` reflecting personal coding-style preferences.

The user overlay is the wrong place for:

- `additionalContext` paths (project-relative; enforced as a hard error per C3).
- Project-specific behavior (use the project overlay).
- Anything that belongs in a stack file.

### Collision and override visibility

When a user runs `gan config print` inside a project, the output shows for each splice point which tier contributed. A user who set `thresholdOverride: 8` and is now running in a project that sets `thresholdOverride: 9` sees:

```
runner.thresholdOverride: 9
  user:    8 (overridden)
  project: 9 (active)
```

This makes "where did this value come from?" answerable without grep'ing the user's home directory.

### `discardInherited` at the user tier

A user can declare `discardInherited: true` to discard the framework's compiled-in defaults. For most splice points (whose defaults are empty lists) this is a no-op. The cases where it has teeth:

- `runner.thresholdOverride`: a user discarding the default leaves the field undefined; the agent's hard-coded baseline applies. Equivalent to not setting the field at all but explicit.
- Any future splice point whose default is non-trivial.

Spec C4 describes the cascade mechanics; U2 highlights the few places where user-tier `discardInherited` is meaningful.

### Auto-memory integration

The user's memory system (e.g. `~/.claude/projects/<project>/memory/`) may want to author parts of the user overlay automatically. R3 supports `gan config set --tier=user <path> <value>` from any process; an auto-memory tool calls this to record durable preferences.

The contract for auto-memory authors:

- They write through `gan config set`, not by editing the file directly.
- They never overwrite user-authored splice points without flagging the conflict.
- They tag auto-managed entries with a sentinel comment in the YAML body (the file's free-form prose region preserved per C3) so the user can identify them.

This is a soft contract — the API does not enforce attribution — but documenting it gives memory tools a clean integration story.

### When to use user overlay vs. project overlay

User overlay = "I always want this." Project overlay = "this project specifically wants this." If a user catches themselves setting the same project-level value across many projects, that's a signal to move it to the user overlay.

Conversely, if a user's overlay is being overridden by every project anyway, that's a signal to move it to the project overlay (or remove it).

## Acceptance criteria

- `gan config set --tier=user runner.thresholdOverride 8` creates `~/.claude/gan/config.md` if absent; subsequent `gan config print` from any project shows the user-tier value contributing.
- A user overlay declaring `additionalContext` produces a structured load-time error per C3.
- `gan config print` output distinguishes user-tier and project-tier provenance for every splice point.
- `gan config set --tier=user generator.additionalRules ...` from a script outside `/gan` writes the file successfully (auto-memory integration path works).
- The user-facing error surface never references the file's location in a way that assumes a specific OS or shell.

## Dependencies

- C3, C4 (overlay schema and cascade)
- R3 (`gan config` commands)
- O1 (provenance reporting in `gan config print`)

## Bite-size note

Sprintable as: `--tier=user` flag in R3 → provenance reporting in `gan config print` → README guide for user overlay → auto-memory contract documentation.
