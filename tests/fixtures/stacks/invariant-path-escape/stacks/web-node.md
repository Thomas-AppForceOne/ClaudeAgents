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

# web-node (path-escape fixture)

Minimal built-in stack. The invariant trigger lives in the project
overlay, which declares an additionalContext path traversing outside
the project root.
