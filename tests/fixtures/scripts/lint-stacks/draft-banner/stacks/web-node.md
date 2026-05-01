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

# DRAFT — replace TODOs before committing.

This fixture's body is schema-clean but its first non-blank prose line
is the verbatim DRAFT banner — `lint-stacks` must fire the
`ScaffoldBannerPresent` issue.
