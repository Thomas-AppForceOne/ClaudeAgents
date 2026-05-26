---
schemaVersion: 1
stack:
  override:
    - php-grav
---

# Project overlay (single-stack-detection fixture)

Declares `stack.override: [php-grav]` in a project where only `php-grav`
auto-detects (there is a `composer.json` but no `package.json`/lockfile, so
`web-node` does not match). Override and detection are the same single stack,
so no StackOverrideShrinkage warning fires.
