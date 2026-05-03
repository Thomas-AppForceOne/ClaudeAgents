---
name: web-node
description: Node.js / TypeScript web stack — HTTP services, browser bundles,
  and CLI tooling running on a Node runtime.
schemaVersion: 1
detection:
  - allOf:
      - package.json
      - anyOf:
          - package-lock.json
          - pnpm-lock.yaml
          - yarn.lock
          - path: package.json
            contains:
              - '"start"'
              - '"dev"'
              - '"build"'
scope:
  - '**/*.ts'
  - '**/*.tsx'
secretsGlob:
  - js
  - ts
  - tsx
  - jsx
  - mjs
  - cjs
  - json
  - env
cacheEnv:
  - envVar: NPM_CONFIG_CACHE
    valueTemplate: <worktree>/.gan-cache/npm
buildCmd: npm run build
testCmd: npm test
lintCmd: vitest run
auditCmd:
  command: npm audit --audit-level=high
  absenceSignal: warning
  absenceMessage: >
    The framework could not run the dependency audit for this stack. Confirm a
    Node toolchain is available on PATH and re-run, or run the audit manually
    before merging.
securitySurfaces:
  - id: tls_required_for_sensitive_traffic
    template: >
      Network calls that carry credentials, session tokens, or other sensitive
      payloads must use TLS. Plaintext HTTP is acceptable only for local
      development against loopback addresses; production code paths must reject
      non-TLS endpoints.
    triggers:
      keywords:
        - http://
        - fetch(
        - request(
        - createServer
        - https
      scope:
        - '**/*.ts'
        - '**/*.tsx'
        - '**/*.js'
        - '**/*.jsx'
  - id: cors_not_wide_open
    template: >
      CORS configuration must not permit arbitrary origins by default. A
      wildcard origin is acceptable only when the spec explicitly requires it
      and the endpoint serves no credentialed traffic.
    triggers:
      keywords:
        - Access-Control-Allow-Origin
        - cors(
        - 'origin: "*"'
      scope:
        - '**/*.ts'
        - '**/*.js'
  - id: session_cookie_flags
    template: >
      Session and authentication cookies must set `httpOnly`, `secure`, and a
      `SameSite` attribute appropriate for the deployment. The defaults of
      common frameworks are not sufficient — the flags must be set explicitly.
    triggers:
      keywords:
        - Set-Cookie
        - session(
        - cookie(
        - express-session
      scope:
        - '**/*.ts'
        - '**/*.js'
  - id: http_route_input_validation
    template: >
      Every HTTP request body, query parameter, header, and path segment that
      reaches business logic or storage must pass through a validation step that
      rejects malformed input before use.
    triggers:
      keywords:
        - req.body
        - req.query
        - req.params
        - request.body
        - ctx.request
      scope:
        - '**/*.ts'
        - '**/*.js'
  - id: shell_and_subprocess_safety
    template: >
      When invoking subprocesses, prefer `execFile` or `spawn` with argument
      arrays over `exec` with interpolated strings. User- controlled values must
      never be concatenated into a shell command line.
    triggers:
      keywords:
        - child_process
        - exec(
        - execSync
        - spawn(
      scope:
        - '**/*.ts'
        - '**/*.js'
  - id: prototype_pollution
    template: >
      Object property assignments that incorporate user-controlled keys must
      guard against prototype pollution by rejecting `__proto__`, `constructor`,
      and `prototype` keys before merging.
    triggers:
      keywords:
        - Object.assign
        - merge(
        - lodash.merge
        - deepMerge
      scope:
        - '**/*.ts'
        - '**/*.js'
  - id: secrets_not_committed
    template: >
      Credentials, API keys, and tokens must not appear in source files,
      lockfiles, or environment files committed to the repository. Secrets are
      loaded from environment variables or a secrets manager at runtime.
    triggers:
      keywords:
        - apiKey
        - api_key
        - secret
        - password
        - token
      scope:
        - '**/*.ts'
        - '**/*.js'
        - '**/*.json'
        - '**/*.env'
---

# web-node conventions

This is the canonical `web-node` stack file shipped with the framework.
It activates whenever a project root contains `package.json` together
with either a recognised lockfile (`package-lock.json`, `pnpm-lock.yaml`,
`yarn.lock`) or a `package.json` whose contents reference the standard
`start` / `dev` / `build` script entries — the composite is the
framework's signal that the project is a real Node workspace and not a
stray manifest fragment.

The `auditCmd` runs the ecosystem's standard high-severity dependency
audit. The `securitySurfaces` array catalogs the recurring web-stack
hazards that the evaluator templates into per-sprint criteria when a
matching keyword or scope trigger fires.

Users who need to diverge from these defaults fork the file into their
project tier (`.claude/gan/stacks/web-node.md`) and edit the fork; the
overlay cascade is for narrow splice points, not structural fields.
