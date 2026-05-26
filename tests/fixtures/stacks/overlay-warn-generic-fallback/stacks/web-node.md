---
name: web-node
description: Synthetic web-node stack fixture (overlay-warning coverage only).
schemaVersion: 1
detection:
  - allOf:
      - package.json
      - package-lock.json
scope:
  - "**/*.ts"
  - "**/*.js"
secretsGlob:
  - js
  - ts
  - json
---

# web-node conventions

Synthetic, fixture-only web-node stack. Activates when both `package.json` and
`package-lock.json` are present, mirroring the real detection signal closely
enough to drive the shrinkage comparison.
