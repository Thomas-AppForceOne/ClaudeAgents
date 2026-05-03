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

# web-node (detection-on-tier1or2 fixture)

Clean built-in stack — detection is allowed at tier 3.
