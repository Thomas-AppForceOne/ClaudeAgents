---
schemaVersion: 1
web-node:
  buildCmd: custom-build
---

# Project overlay (single per-stack-override fixture)

Declares a per-stack command override `web-node.buildCmd`. The override is
recorded but not yet applied, so a PerStackOverrideUnsupported warning fires
naming `web-node` and field `buildCmd`.
