---
name: web-node
schemaVersion: 1
detection:
  - anyOf:
      - package.json
scope:
  - "**/*.ts"
sortableLists:
  - lineRangePattern: "^import "
---

# web-node conventions (malformed: sortableLists item missing pathGlob)

Used to assert that a sortableLists entry missing its required `pathGlob`
produces a SchemaMismatch issue rather than validating clean.
