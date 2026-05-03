---
name: web-node
schemaVersion: 1
detection:
  - anyOf:
      - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build --offline"
testCmd: "npm test"
lintCmd: "npm run lint"
---

# web-node (project-tier shadow with detection)

Project-tier shadow that declares a `detection` block — forbidden
outside the built-in tier per the `detection.tier3_only` invariant.
