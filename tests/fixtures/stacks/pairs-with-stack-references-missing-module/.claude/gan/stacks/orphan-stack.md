---
name: orphan-stack
schemaVersion: 1
pairsWith: nonexistent-module
detection:
  - sentinel-file
scope:
  - "**/*.ts"
buildCmd: "true"
testCmd: "true"
lintCmd: "true"
---

# orphan-stack (references missing module)

This stack file declares `pairsWith: nonexistent-module` but no
module with that name is registered. The `pairs-with.consistency`
invariant must fire.
