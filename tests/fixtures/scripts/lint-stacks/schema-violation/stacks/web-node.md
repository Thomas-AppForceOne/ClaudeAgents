---
name: web-node
schemaVersion: 999
detection:
  - anyOf:
      - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
---

# web-node (schema-violation fixture)

Declares `schemaVersion: 999`. The framework only supports
`schemaVersion: 1`, so the schema-check helper must emit a
`SchemaMismatch` issue on this file. Used by `lint-stacks` to verify
the schema-fail branch.
