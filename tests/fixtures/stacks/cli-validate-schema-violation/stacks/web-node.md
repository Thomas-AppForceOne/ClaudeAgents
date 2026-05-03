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
securitySurfaces:
  - id: surface-without-template
secretsGlob:
  - ".env"
---

# web-node (cli-validate-schema-violation fixture)

Two schema-shape failures, no cross-file invariant violations:

- `securitySurfaces[0]` is missing the required `template` property.
- `secretsGlob[0]` starts with a dot (schema pins `pattern: "^[^.]"`).

Used by `tests/cli/commands/validate.test.ts` to verify the CLI's exit-2
mapping for schema-only failures (no `InvariantViolation` issues).
