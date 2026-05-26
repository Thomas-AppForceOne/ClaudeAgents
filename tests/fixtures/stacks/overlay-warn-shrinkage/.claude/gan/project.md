---
schemaVersion: 1
stack:
  override:
    - php-grav
---

# Project overlay (shrinkage fixture)

Declares `stack.override: [php-grav]` while both `php-grav` and `web-node`
auto-detect from the files on disk. The override therefore suppresses
`web-node`, which is the StackOverrideShrinkage scenario.
