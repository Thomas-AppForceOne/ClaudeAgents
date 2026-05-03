---
name: web-node-b
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
    valueTemplate: "22"
---

# web-node-b

Built-in stack declaring NODE_VERSION=22 — conflicts with `web-node-a`.
The `cacheEnv.no_conflict` invariant must fire.
