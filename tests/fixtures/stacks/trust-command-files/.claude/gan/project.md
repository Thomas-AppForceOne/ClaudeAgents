---
schemaVersion: 1
evaluator:
  additionalChecks:
    - command: echo trust-fixture
      on_failure: warning
---

# Project overlay (trust-command-files fixture)

Declares one `evaluator.additionalChecks` entry so the R5 trust gate
fires for this fixture. The check itself is a harmless `echo` — the
fixture exists purely to give the trust integration something to gate
on. Tests inject `homeDir` to a `mkdtempSync` directory so the lookup
never reaches the real `~/.claude/gan/trust-cache.json`.
