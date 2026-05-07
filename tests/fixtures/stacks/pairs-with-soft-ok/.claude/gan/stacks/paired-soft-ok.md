---
name: paired-soft-ok
schemaVersion: 1
detection:
  - sentinel-file
scope:
  - "**/*.ts"
buildCmd: "true"
testCmd: "true"
lintCmd: "true"
---

# paired-soft-ok (project-tier, no pairsWith)

The module side declares `pairsWith: paired-soft-ok`; this stack file
omits `pairsWith` deliberately. Per the soft-OK rule, the absence is
not an error — pairing is a one-way declaration from the module to
its stack.
