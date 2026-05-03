---
name: web-node
description: web-node fixture (polyglot)
schemaVersion: 1
detection:
  - allOf:
      - package.json
      - anyOf:
          - package-lock.json
          - pnpm-lock.yaml
          - yarn.lock
scope:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
secretsGlob:
  - js
  - ts
  - json
cacheEnv:
  - envVar: NPM_CONFIG_CACHE
    valueTemplate: "<worktree>/.gan-cache/npm"
buildCmd: "npm run build"
testCmd: "npm test"
lintCmd: "npm run lint"
securitySurfaces:
  - id: prototype_pollution
    template: >
      Object property assignments must guard against prototype pollution
      by rejecting `__proto__`, `constructor`, and `prototype` keys
      sourced from user input.
    triggers:
      keywords:
        - "Object.assign"
        - "merge"
      scope:
        - "**/*.ts"
        - "**/*.js"
---

# web-node conventions

Polyglot fixture's web-node stack file. Activates whenever both
`package.json` and a recognised lockfile are present in the project root.
