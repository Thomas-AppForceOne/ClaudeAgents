---
schemaVersion: 1
proposer:
  additionalContext:
    - ../../etc/passwd
---

# Project overlay (path-escape fixture)

Lists `../../etc/passwd` under `proposer.additionalContext`. The path
traverses outside the project root; the `path.no_escape` invariant must
fire with `InvariantViolation`.
