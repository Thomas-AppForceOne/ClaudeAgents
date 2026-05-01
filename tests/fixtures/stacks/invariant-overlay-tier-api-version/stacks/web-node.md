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

# web-node (overlay-tier-api-version fixture)

Minimal built-in stack. The invariant trigger lives in the project
overlay, which declares schemaVersion: 999.
