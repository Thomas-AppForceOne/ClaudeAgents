# F2 — Configuration API contract

**Status:** Stub. Drafted in Phase 0.

## Purpose

Defines the agent-facing Configuration API as a black box. Agents read and write framework configuration only through this API; they do not parse files, know schemas, or know storage details.

## Anticipated content

- Function surface (bulk reads + targeted writes; no per-field chatty access).
- MCP binding: function-to-tool mapping, parameter shapes, return types.
- Validation timing: single `validateAll()` pass at run start, before worktree creation. Agents do not revalidate.
- Error model: structured errors with file/field provenance; never silent failure.
- Install / restart story: one-time installer, one Claude Code restart, ready forever after.
- Markdown body split: structured YAML body owned by API, free-form `conventions` prose hand-edit-only with read-only API exposure.

## Dependencies

- F1 (filesystem layout)
- F3 (schema authority and versioning)

## Bite-size note

This spec defines the **contract** only. The reference implementation lives in R1. A separate sprint can implement R1 once the contract is locked.
