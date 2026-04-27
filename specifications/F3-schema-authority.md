# F3 — Schema authority and versioning

## Problem

The framework has multiple configuration file formats (stack files, project overlay, user overlay, module manifest, future formats), each with its own schema. Today schema rules are scattered across the specs that introduce them, and versioning policy is repeated piecemeal. Without a single authority, schemas drift and the API (F2) cannot apply uniform validation.

This spec consolidates schema authoring and versioning meta-rules. Domain specs (C1, C3, M1, …) author the actual schemas; this spec defines how.

## Proposed change

### Schema authoring

Every config file format declares its schema as a JSON Schema document. Schema documents live at the repo root in:

```
schemas/
  stack-v1.json
  overlay-v1.json
  module-manifest-v1.json
  …
```

Naming: `<file-type>-v<N>.json`, where `<file-type>` is the kind of config file and `<N>` is the schemaVersion the document describes.

Each domain spec authors the JSON Schema for its file type as part of its content (C1 owns `stack-v1.json`, C3 owns `overlay-v1.json`, M1 owns `module-manifest-v1.json`). The schema document is the authoritative declarative description; English prose in the spec is illustrative only.

### `schemaVersion` semantics

Every config file declares `schemaVersion` in its frontmatter. The API enforces:

1. **Exact match required.** Readers fail on any version they do not understand. No compatibility ranges. No graceful downgrade. No forward-compat reads.
2. **Pre-1.0 WIP rule:** any schema change bumps the version. Additive changes do not get a free pass. This applies across the whole framework while the project is pre-1.0.
3. **Schema documents are immutable once published.** To change a schema, write a new `<file-type>-v<N+1>.json` and bump consumers in lockstep.

The API knows which versions it can read; this is part of its compiled-in metadata. An R1 instance built against `schemas/stack-v1.json` reads stack files with `schemaVersion: 1` and rejects any other version with a `SchemaMismatch` error.

### Cross-file invariants

Some validation rules span multiple files and cannot be expressed in a single JSON Schema. The API's validation pipeline runs cross-file checks **after** schema validation:

```
validateAll():
  for each config file:
    schema_validate(file, schemas/<type>-v<schemaVersion>.json)
    on failure: collect error, continue
  for each cross-file invariant:
    check(invariant)
    on failure: collect error
  if any errors: return structured report
  else: return OK
```

This spec catalogs the cross-file invariants the API enforces. Each invariant is named, sourced to the spec that motivates it, and listed once here so any reviewer can see the full set.

| Invariant | Source spec | Description |
|---|---|---|
| `pairsWith.consistency` | M1 | If `src/modules/<name>/` and `stacks/<name>.md` both exist, both must declare `pairsWith` referring to each other; the names must match. |
| `cacheEnv.no_conflict` | C1 | Across active stacks, no two stacks may declare `cacheEnv` entries with the same `envVar` and different `valueTemplate`. |
| `additionalContext.path_resolves` | U3 | Each path listed in `planner.additionalContext` or `proposer.additionalContext` resolves to a readable file at validation time. Warning level (file may legitimately be missing during early authoring). |
| `overlay.tier_apiVersion` | C3 | Each overlay tier's `schemaVersion` matches the API's known overlay schema version. |
| `stack.tier_apiVersion` | C1 | Each active stack file's `schemaVersion` matches the API's known stack schema version. |

Invariants are implemented in code (R1) but live conceptually here so the catalog is centralised.

### API versioning

The API contract itself is versioned separately from per-file schemas. The current API version is exposed via `getApiVersion()` (F2). Mismatches between caller and server produce a structured `UnknownApiVersion` error.

API version bumps happen when F2's function surface or error model changes. They are independent of file-schema bumps; both can change at different cadences.

This is also independent of MCP's own protocol version; both must agree, but they evolve separately.

### Integration with R4 lint

R4's stack-file lint script reads the same `schemas/*.json` documents the API does. There are no shadow rules. A file that passes the lint must pass the API's schema validation, and vice versa. Cross-file invariants are also runnable as a lint check.

## Acceptance criteria

- Every config file format has a corresponding `schemas/<type>-v<N>.json` document at the repo root.
- The R1 reference implementation imports these schema documents at build time; no schema rules live in code.
- A config file with a `schemaVersion` the API does not recognise produces a structured `SchemaMismatch` error citing the file and both versions.
- Cross-file invariants run only after per-file schema validation passes, and the catalog in this spec lists every invariant the API enforces.
- Bumping a schema version requires creating a new immutable `<type>-v<N+1>.json`; the previous file remains in git history but is no longer referenced from any current code.
- The R4 lint script and the R1 API report identical schema validation results for any given file.

## Dependencies

- F1 (where schemas live).

## Bite-size note

This spec is meta-rules only. Authoring an actual schema document is per-domain work in the relevant C / M spec. Bumping a schema during a future change is a documented procedure (write new `-vN+1.json`, update consumers), not a new spec.
