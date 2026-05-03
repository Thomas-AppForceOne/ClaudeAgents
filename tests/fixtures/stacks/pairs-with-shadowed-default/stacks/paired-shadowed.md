---
name: paired-shadowed
schemaVersion: 1
pairsWith: paired-shadowed
detection:
  - sentinel-file
scope:
  - "**/*.ts"
buildCmd: "true"
testCmd: "true"
lintCmd: "true"
---

# paired-shadowed (fixture-internal built-in)

This is the canonical built-in stack file located at the fixture's
own `stacks/` directory (NOT the real repo-root `stacks/`). Per
phase-1 discovery, both `<fixtureRoot>/stacks/*.md` and `<repoRoot>/stacks/*.md`
are scanned as the built-in tier; tests inject this fixture as the
project root so the fixture-internal copy is the one in scope.
