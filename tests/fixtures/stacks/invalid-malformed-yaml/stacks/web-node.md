---
name: web-node
schemaVersion: 1
detection:
  - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build"
broken: [
testCmd: "npm test"
---

# web-node (malformed-YAML fixture)

The YAML body has an unclosed bracket on the `broken:` line; the parser
must report `InvalidYAML` and the validate pipeline must surface that as
an issue (not crash).
