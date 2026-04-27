# R1 — Configuration MCP server (reference implementation)

**Status:** Stub. Drafted in Phase 2.

## Purpose

Reference implementation of the Configuration API contract (F2). Implemented as a Node 18+ MCP server.

Owns:
- Reading every config file from F1's filesystem zones.
- Validating against schemas declared per F3 (using JSON Schema validation).
- Resolving the three-tier cascade (C4 for overlays, C5 for stack files).
- Running stack detection and dispatch (C2).
- Exposing the function surface defined in F2 as MCP tools.
- Running invariant checks across files (e.g. `pairsWith` consistency between stacks and modules).

## Anticipated content

- Repo layout: where the server lives, package structure.
- MCP tool definitions: one tool per function in F2.
- Validation pipeline: schema validation, then cross-file invariants, then resolution.
- Error reporting: structured errors with file/field/line provenance.
- Lifecycle: process spawn from MCP client, stays alive while client is open.
- Versioning: server advertises its supported API version; agents detect mismatch.
- Test coverage: unit tests for each tool, integration tests against fixture configs.

## Dependencies

- F1 (filesystem layout)
- F2 (API contract)
- F3 (schema authority)
- C1, C2, C3, C4, C5 (data models the server serves)

## Bite-size note

This spec is implementation-focused. It can be sprint-sized into:
1. Server skeleton + MCP tool registration.
2. Reader functions (return-only, no validation).
3. Validation pipeline (schemas + invariants).
4. Resolver (cascade + dispatch).
5. Updater functions (validated writes).
