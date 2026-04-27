# M2 — Docker module

**Status:** Stub. Drafted in Phase 4. Content sourced from M1's current Docker section.

## Purpose

First concrete runtime utility module. Provides agents with reusable JavaScript utilities for Docker container and port management in git worktrees.

## Anticipated content

- `PortRegistry` — persists port assignments across shell sessions. State stored at `.gan-state/modules/docker/port-registry.json` (zone 2 per F1).
- `PortDiscovery` — three-layer fallback (env → registry → docker ps → fallback).
- `ContainerHealth` — HTTP-based health checks (not just port binding).
- `PortValidator` — platform-specific port-availability checks.
- `ContainerNaming` — convention-driven container names tied to worktree paths.
- Pairing: declared `pairsWith: docker` and consistent with a future `stacks/docker.md`. The Configuration API enforces this on registration (F2).

## Dependencies

- F1 (filesystem layout — zone 2 for port registry)
- F2 (API contract — for `pairsWith` invariant)
- M1 (modules architecture — install/distribution model)

## Bite-size note

This is not a single sprint. Each utility is independently testable. Recommend ordering: PortRegistry → PortDiscovery → ContainerHealth → PortValidator → ContainerNaming, as later utilities depend on earlier abstractions.
