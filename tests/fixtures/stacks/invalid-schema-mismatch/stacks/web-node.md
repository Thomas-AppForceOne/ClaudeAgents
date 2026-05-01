---
name: web-node
schemaVersion: 1
detection:
  - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
securitySurfaces:
  - id: surface-without-template
secretsGlob:
  - ".env"
---

# web-node (multi-violation schema-mismatch fixture)

This fixture's YAML body parses cleanly but breaks `stack-v1.json` in two
places at once:

- `securitySurfaces[0]` is missing the required `template` property.
- `secretsGlob[0]` starts with a dot (the schema pins `pattern: "^[^.]"`).

S3's validate pipeline must report both issues for this single file (no
short-circuit on the first error).
