# Docker module

Five utilities for `/gan` worktree workflows that run inside Docker
containers:

- `PortRegistry` — persists worktree -> {port, containerName} mappings
  at `<projectRoot>/.gan-state/modules/docker/port-registry.json`.
- `ContainerNaming` — `nameForWorktree(worktreePath)` deterministic,
  container-safe names derived from the worktree's last path segment
  plus a 4-hex SHA-256 prefix of the canonical worktree path.
- `PortValidator` — platform-aware `isPortFree(port)`. macOS via `lsof`,
  Linux via `ss` (decided by stdout content, not exit code), Windows
  throws `PlatformNotSupported`.
- `PortDiscovery` — `discoverPort(options)` walks four layers in order:
  env-var name (NOT value), `PortRegistry` lookup, `docker ps` parse,
  fallback port.
- `ContainerHealth` — `waitForHealthy(port, options)` polls
  `http://localhost:<port><options.path>` via stdlib `fetch` until the
  expected status is observed; per-poll bound at `min(2000, remaining)` ms.

## Project configuration

Modules read their per-project config via
`getResolvedConfig().modules.docker`. The four-field schema lives at
`schemas/module-config-docker-v1.json`:

```yaml
schemaVersion: 1
containerPattern: "myapp-*"
fallbackPort: 8080
healthCheck:
  path: "/health"
  expectStatus: 200
  timeoutSeconds: 30
```

## Platform support

macOS (primary) and Linux (best-effort). Windows is not supported in
v1 — `PortValidator.isPortFree` throws `PlatformNotSupported` on
Windows, and any caller that depends on it inherits the platform gate.

## Prerequisite check

Importing the barrel runs `docker --version` via
`child_process.execFileSync` (whitespace-split, no shell). A non-zero
exit or spawn error throws `ModulePrerequisiteFailed` with the
manifest's `errorHint` woven into the message.

## Troubleshooting

Pre-M3 builds wrote module state to a single
`.gan-state/modules/<name>/state.json` per module. After upgrading,
that file is orphaned — never read, never written — and may safely
be deleted:

```sh
rm <projectRoot>/.gan-state/modules/docker/state.json
```

The current per-key file `port-registry.json` lives alongside it and
is unaffected. Cleanup is optional; the orphan is harmless.
