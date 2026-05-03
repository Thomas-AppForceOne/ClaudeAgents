---
name: paired-shadowed
schemaVersion: 1
detection:
  - sentinel-file
scope:
  - "**/*.ts"
buildCmd: "true"
testCmd: "true"
lintCmd: "true"
---

# paired-shadowed (project-tier shadow, no pairsWith)

Shadows the canonical fixture-internal built-in but omits the
`pairsWith` declaration. The `pairs-with.consistency` invariant must
fire the C5 verbatim remediation hint.
