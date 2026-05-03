---
name: web-node-a
schemaVersion: 1
detection:
  - anyOf:
      - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
cacheEnv:
  - envVar: NODE_VERSION
    valueTemplate: "20"
---

# web-node-a (multi-violation fixture)

Built-in stack declaring NODE_VERSION=20.
