---
name: docker
schemaVersion: 1
scope:
  - "**/Dockerfile"
buildCmd: "docker build . --pull"
testCmd: "docker compose up --abort-on-container-exit"
lintCmd: "docker compose config"
---

# docker (project-tier shadow)

Shadows the canonical built-in `stacks/docker.md` but omits the
`pairsWith` declaration. The `pairsWith.consistency` invariant must fire
the C5 verbatim remediation hint when `validateAll` runs against this
fixture.
