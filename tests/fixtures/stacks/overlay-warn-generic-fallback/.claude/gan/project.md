---
schemaVersion: 1
stack:
  override:
    - php-grav
---

# Project overlay (generic-fallback shrinkage fixture)

Declares `stack.override: [php-grav]` in a project where NO stack auto-detects
(no `composer.json`, no `package.json`). Auto-detection would have fallen back
to `generic`; the override excludes `generic`, so the fallback semantics are
lost and a StackOverrideShrinkage warning fires naming `generic`.
