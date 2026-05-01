---
name: web-node
schemaVersion: 999
detection:
  anyOf:
    - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
---

# web-node (invalid schemaVersion fixture)

This fixture intentionally declares `schemaVersion: 999`. Schema-version
validation is owned by S3 (validate paths); for S2 the fixture exists only
to prove the S2 loader path does not crash on an out-of-range value (the
loader reads and parses YAML, but does not yet enforce schema versions).
