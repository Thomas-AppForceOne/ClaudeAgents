---
name: docker
schemaVersion: 1
pairsWith: docker
detection:
  - anyOf:
      - Dockerfile
      - docker-compose.yml
scope:
  - "**/Dockerfile"
buildCmd: "docker build ."
testCmd: "docker compose up --abort-on-container-exit"
lintCmd: "docker compose config"
---

# docker (built-in fixture)

Built-in stack file with `pairsWith: docker`. The project-tier shadow at
`.claude/gan/stacks/docker.md` deliberately omits `pairsWith` so the
`pairsWith.consistency` invariant fires the C5 verbatim error.
