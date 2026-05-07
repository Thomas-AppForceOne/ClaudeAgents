---
name: paired-disagree
schemaVersion: 1
pairsWith: some-other-module
detection:
  - sentinel-file
scope:
  - "**/*.ts"
buildCmd: "true"
testCmd: "true"
lintCmd: "true"
---

# paired-disagree (disagree case)

This project-tier stack file declares `pairsWith: some-other-module`,
disagreeing with the module's `pairsWith: paired-disagree`. The
`pairs-with.consistency` invariant must fire.
