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
docLintCmd:
  command: "npm run doc-lint"
  absenceSignal: warning
  severity: critical
---

# web-node (malformed-docLintCmd fixture)

Declares a body-schema-valid `schemaVersion: 1` but a malformed
`docLintCmd`: the `severity` value `critical` is outside the
`blocker | warning | advisory` enum, and `absenceMessage` is missing
even though `absenceSignal` is `warning` (not `silent`). The body
schema must reject this through the existing ajv body validation —
no bespoke check — so `lint-stacks` emits a `SchemaMismatch` issue
and exits 1. Used by `lint-stacks` to verify the Q5 `docLintCmd`
rejection branch.
