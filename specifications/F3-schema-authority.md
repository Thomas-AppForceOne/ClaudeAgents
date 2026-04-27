# F3 — Schema authority and versioning

**Status:** Stub. Drafted in Phase 0.

## Purpose

Single source of truth for how every framework config schema is declared, where its JSON Schema document lives, and how `schemaVersion` works across all config files.

Consolidates versioning language currently scattered across C1 (stack file `schemaVersion`), C3 (overlay `schemaVersion`), and elsewhere.

## Anticipated content

- Schema location: where JSON Schema documents live in the repo.
- `schemaVersion` semantics: exact-match required, no compatibility range. Pre-1.0 WIP: any change bumps the version.
- Cross-file version handshake: how the API rejects a stack file or overlay whose version it doesn't understand.
- Lint script integration: schemas drive both lint validation and API runtime validation.
- Versioning of the API itself (separate from per-config-file versioning).

## Dependencies

- F1 (filesystem layout — schema files live somewhere)

## Bite-size note

Schema documents themselves (e.g. the stack-file JSON Schema) are authored alongside their domain spec (C1, C3, etc.). This spec defines the *meta-rules* about authorship and versioning, not the schemas themselves.
