---
schemaVersion: 1
stack:
  override:
    - php-grav
    - web-node
---

# Project overlay (override-equals-detection fixture)

Declares `stack.override: [php-grav, web-node]` while both stacks auto-detect.
The override matches detection exactly, so no coverage is lost and no
StackOverrideShrinkage warning fires.
