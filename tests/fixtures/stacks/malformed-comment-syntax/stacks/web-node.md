---
name: web-node
schemaVersion: 1
detection:
  - anyOf:
      - package.json
scope:
  - "**/*.ts"
commentSyntax:
  block:
    open: "/*"
---

# web-node conventions (malformed: commentSyntax.block missing close)

Used to assert that a commentSyntax.block missing its required `close` produces
a SchemaMismatch issue rather than validating clean.
