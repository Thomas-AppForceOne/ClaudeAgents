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

# web-node-b (multi-violation fixture)

Built-in stack declaring NODE_VERSION=22 — conflicts with `web-node-a`'s
NODE_VERSION=20. The `cacheEnv.no_conflict` invariant fires here. The
project overlay (`.claude/gan/project.md`) additionally lists a path that
escapes the project root, so `path.no_escape` also fires — verifying
that `validateAll` surfaces both invariants in one run.
