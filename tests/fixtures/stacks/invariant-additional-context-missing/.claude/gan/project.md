---
schemaVersion: 1
proposer:
  additionalContext:
    - docs/missing.md
---

# Project overlay (additional-context-missing fixture)

Lists `docs/missing.md` under `proposer.additionalContext`. The file
deliberately does not exist on disk; the
`additionalContext.path_resolves` invariant must fire as a warning.
