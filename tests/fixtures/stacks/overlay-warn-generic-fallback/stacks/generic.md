---
name: generic
description: Synthetic fallback stack fixture (overlay-warning coverage only).
schemaVersion: 1
scope:
  - "**/*"
secretsGlob:
  - env
---

# generic conventions

Synthetic, fixture-only fallback stack with no `detection` block, so it can
only activate via the resolver's empty-match fallback. Present so the
generic-fallback shrinkage scenario has a fallback target to lose.
