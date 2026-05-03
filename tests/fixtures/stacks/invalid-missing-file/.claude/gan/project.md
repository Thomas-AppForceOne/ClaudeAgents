---
schemaVersion: 1
stack:
  override:
    - never-defined-stack
---

# Project overlay (invalid-missing-file fixture)

The `stack.override` list references a stack name that has no
corresponding file at any tier. S3's discovery phase must surface this
as a `MissingFile` issue.
