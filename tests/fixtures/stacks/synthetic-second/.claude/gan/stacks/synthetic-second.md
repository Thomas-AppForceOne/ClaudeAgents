---
name: synthetic-second
schemaVersion: 1
scope:
  - "synthetic/**"
buildCmd: "echo synthetic-second build"
testCmd: "echo synthetic-second test"
lintCmd: "echo synthetic-second lint"
---

# synthetic-second conventions

Project-tier override fixture. Has no `detection` block (per the
`detection-tier3-only` invariant — detection lives only in the built-in
tier). The full multi-stack synthetic stack file with composite detection
lands in S5/S7 when the synthetic-second built-in fixture grows.
