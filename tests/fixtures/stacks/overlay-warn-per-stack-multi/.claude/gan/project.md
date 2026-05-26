---
schemaVersion: 1
web-node:
  buildCmd: x
  testCmd: y
php-grav:
  buildCmd: z
---

# Project overlay (multi-stack per-stack-override fixture)

Declares per-stack command overrides for two stacks: `web-node` (buildCmd and
testCmd) and `php-grav` (buildCmd). This produces exactly two
PerStackOverrideUnsupported warnings, one per stack, with `web-node` carrying
both fields collapsed into a single warning.
