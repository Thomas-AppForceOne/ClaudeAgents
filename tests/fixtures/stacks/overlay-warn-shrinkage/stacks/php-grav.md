---
name: php-grav
description: Synthetic PHP/Grav stack fixture (overlay-warning coverage only).
schemaVersion: 1
detection:
  - composer.json
scope:
  - "**/*.php"
secretsGlob:
  - php
---

# php-grav conventions

Synthetic, fixture-only stack used to exercise the overlay-misuse warning
surfaces. It activates when a `composer.json` is present. It is not a shipped
stack; it exists so a multi-stack detection result can be compared against a
narrower `stack.override` without depending on the real stack catalog.
