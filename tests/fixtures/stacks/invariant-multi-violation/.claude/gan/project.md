---
schemaVersion: 1
proposer:
  additionalContext:
    - ../../etc/passwd
---

# Project overlay (multi-violation fixture)

Lists `../../etc/passwd` under `proposer.additionalContext` — the
`path.escape` invariant fires. The two built-in stack files
(`web-node-a`, `web-node-b`) also conflict on `NODE_VERSION`, so
`cacheEnv.no_conflict` fires too. `validateAll` must report both.
