---
name: web-node
schemaVersion: 999
detection:
  - anyOf:
      - package.json
scope:
  - "**/*.ts"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
---

# web-node (stack-tier-api-version fixture)

Built-in stack file declaring `schemaVersion: 999`. The
`stack.tier_apiVersion` invariant must fire with `InvariantViolation`.
This fixture is dedicated to the invariant test (separate from
`invalid-stack-resolution/`, which is owned by S2/S3 path tests).
