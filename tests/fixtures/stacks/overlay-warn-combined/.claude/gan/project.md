---
schemaVersion: 1
stack:
  override:
    - php-grav
web-node:
  buildCmd: custom-build
---

# Project overlay (combined both-warnings fixture)

Exercises both surfaces at once: `stack.override: [php-grav]` shrinks the
detected set (suppressing `web-node`), and `web-node.buildCmd` declares a
per-stack command override. The snapshot carries both a StackOverrideShrinkage
warning and a PerStackOverrideUnsupported warning, with no interaction between
them.
