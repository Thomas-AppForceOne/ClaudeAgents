---
name: docker
schemaVersion: 1
pairsWith: docker
detection:
  - Dockerfile
scope:
  - "**/Dockerfile"
buildCmd: "true"
testCmd: "true"
lintCmd: "true"
---

# docker (project-tier fixture, paired with the docker module)

This fixture exercises the M1 pairsWith resolution path against the M2
docker module. It is test-only: there is no shipped repo-tier
`stacks/docker.md` in v1.
