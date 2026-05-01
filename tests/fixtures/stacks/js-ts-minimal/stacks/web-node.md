---
name: web-node
schemaVersion: 1
detection:
  - anyOf:
      - package.json
      - tsconfig.json
scope:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
---

# web-node conventions

Minimal fixture stack file used by R1 tests. Real conventions live in the
`web-node` stack file shipped via E2.
