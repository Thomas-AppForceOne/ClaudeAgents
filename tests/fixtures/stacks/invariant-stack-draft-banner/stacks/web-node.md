---
name: web-node
schemaVersion: 1
detection:
  - anyOf:
      - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
---

# DRAFT — replace TODOs and remove this banner before committing.

This file still carries the `gan stacks new` scaffold banner. The
`stack.no_draft_banner` invariant must fire and require the user to
replace TODOs and remove this banner before committing.
