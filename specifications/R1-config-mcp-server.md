# R1 — Configuration MCP server (reference implementation)

## Problem

F2 defines the Configuration API as a language-neutral contract; F3 defines schema authority. Something has to actually implement those: read files, validate, resolve cascades, expose tools. R1 specifies the reference implementation so it can be built, tested, and shipped.

## Proposed change

A Node 18+ MCP server packaged as `@claudeagents/config-server`. Implements every function in F2's contract; reads schemas from `schemas/*.json` per F3.

### Repository layout

```
src/
  config-server/
    index.ts                    # MCP entry point + tool registration
    errors.ts                   # F2 error factory (single producer of every code)
    scaffold-banner.ts          # R3-shared DRAFT_BANNER constant (single source)
    schemas-bundled.ts          # imports schemas/*.json at build time
    tools/
      reads.ts                  # getResolvedConfig, getStack, getOverlay, getMergedSplicePoints, getStackResolution, getTrustState, trustList, …
      writes.ts                 # updateStackField, setOverlayField, appendToOverlayField, removeFromOverlayField, trustApprove, trustRevoke, …
      validate.ts               # validateAll, validateStack, validateOverlay
    storage/
      stack-loader.ts           # reads stacks/*.md and tier overrides
      overlay-loader.ts         # reads project + user overlays
      module-loader.ts          # reads module manifests
      yaml-block-parser.ts      # extracts the YAML frontmatter block from markdown
      yaml-block-writer.ts      # rewrites the YAML frontmatter block, preserves prose
      atomic-write.ts           # temp-file + rename for every persisted write
    resolution/
      detection.ts              # C2's detection algorithm
      cascade.ts                # C4's three-tier overlay cascade
      stack-resolution.ts       # C5's three-tier stack file resolution
      resolved-config.ts        # composes the resolved view backing getResolvedConfig
      cache.ts                  # per-process resolver cache (keyed by canonical projectRoot)
    invariants/
      index.ts                  # registry of every cross-file invariant
      pairs-with-consistency.ts
      cache-env-no-conflict.ts
      additional-context-path-resolves.ts
      path-escape.ts            # F4 PathEscape (the F2-cataloged code)
      overlay-tier-api-version.ts
      stack-tier-api-version.ts
      detection-tier3-only.ts
      stack-no-draft-banner.ts
    determinism/
      index.ts                  # picomatch glob, realpathSync.native canonicalisation, sorted-key JSON, locale-sensitive sort
    validation/
      schema-check.ts           # per-file schema validation orchestration
    trust/                      # R5
      hash.ts                   # SHA-256 over committed command-declaring files
      cache-io.ts               # ~/.claude/gan/trust-cache.json read/write (mode 0600)
      integration.ts            # validateAll() trust-phase hook
    logging/
      index.ts                  # per-run log routing (GAN_RUN_ID → .gan-state/runs/<id>/logs/config-server.log)
  index.ts                      # re-exports for npm consumers (CLI in R3)
package.json
```

The layout block enumerates the subdirectories R1 ships at sprint completion; downstream specs (R5 in particular) add files **inside** these subdirectories rather than introducing new top-level directories. The `trust/` and `validation/` subdirectories were added during R-series implementation (`trust/` for R5; `validation/` for R1 itself); both are catalogued here so the layout block matches the on-disk tree without a future audit needing to reconcile them.

Test code lives under `tests/config-server/`. Per-tool unit tests, per-resolver unit tests, and integration tests against fixture configs.

### MCP tool registration

Every function in F2 is registered as an MCP tool. Tool names mirror function names. Parameter schemas come from `schemas/api-tools-v1.json` (a separate schema document authored by this spec).

The server uses the official `@modelcontextprotocol/sdk` Node package. Stdio transport for local use; the installer (R2) configures Claude Code to spawn the server on demand.

### Validation pipeline

`validateAll()` runs three phases in order. Each phase collects errors; a phase only stops the next phase if the collected errors prevent meaningful subsequent work (e.g. a missing schema file).

1. **Discovery.** Enumerate stack files (per C5's tier resolution), overlay files at user and project tiers, and module manifests. List the active set per C2's detection.
2. **Per-file schema validation.** For each discovered file, look up the schema by type and `schemaVersion`, validate body YAML against it. Report `SchemaMismatch`, `InvalidYAML`, etc.
3. **Cross-file invariants.** Run each invariant in F3's catalog. Report `InvariantViolation` errors with file/field provenance.

Returns a structured report. The report is the same shape whether `validateAll()` is called as a standalone tool or implicitly at orchestrator startup.

### Resolver

`getResolvedConfig()` runs the validation pipeline (caching the result so an immediately-following call doesn't re-validate), then composes the resolved view:

- Active stack list with tier provenance.
- Per-stack data, with cross-stack cacheEnv conflicts already filtered out (errors at validation time prevent a partial config from being returned).
- Overlay cascade resolved per C4: defaults from the agent's compiled-in defaults, merged with user overlay, merged with project overlay, with `discardInherited` semantics applied.
- additionalContext paths with their resolution status (resolved / missing).
- API version, schema versions in use.

The resolved view is a JSON document with stable shape; consumers can diff it across runs (this is what spec O1's `--print-config` exposes).

#### Resolver cache scope

The validation-pipeline cache is per-process and pinned by the following rules:

- **Cache key:** the canonical `projectRoot` (per F2's path-canonicalisation rule). Two MCP clients connected to the same long-lived server but operating on different projects each get their own cache entry; case-insensitive-filesystem aliasing collapses to one key.
- **Lifetime:** the lifetime of the MCP server process. There is no TTL. The server holds the cache until it exits.
- **Invalidation triggers:** any successful write through this server's API (any of the F2 write functions returning `mutated: true`) invalidates the cache entry for that `projectRoot`. **User-side file edits do not invalidate.** This is by design — F2's snapshot freshness rule says external state is stable for the run; if a user edits an overlay file mid-run and that edit invalidated the cache, the snapshot frozen-across-user-edits guarantee breaks. Users picking up edits is achieved by aborting the run and starting a new `/gan` (which spawns a new orchestrator session, calls `validateAll()` afresh, and produces a new snapshot).
- **Idempotency:** repeated `getResolvedConfig(projectRoot)` calls between writes return byte-identical JSON. Test fixtures rely on this.

Multi-client / multi-project servers (per F2) work correctly because cache entries are keyed per canonical projectRoot and writes invalidate only the affected entry.

### Writes

Every write function:

1. Loads the current file (or composes a new one if absent).
2. Applies the requested change in memory.
3. Validates the new state through the same pipeline `validateAll()` uses, scoped to the affected file plus any invariants the change could break.
4. On success, writes the file back, preserving any prose outside the YAML body block byte-identically (the YAML body block is replaced in place; everything else — frontmatter, markdown headings, conventions section, comments — is byte-identical before and after).
5. On failure, returns a structured error and does not persist.

Write atomicity: file writes use temp-file + rename so concurrent readers never see a partially-written file. The reference implementation does not need cross-process locking — only the MCP server writes; concurrent readers via the API serialise through the server.

`appendToStackField` and `removeFromStackField` are implemented as a single atomic load-mutate-validate-persist cycle inside the server. Two concurrent calls to either operation on the same field serialise through the server's single-writer discipline; neither can observe the other's intermediate state. This avoids the R-M-W race that would arise from a caller doing `getStack()` + `updateStackField()` in two MCP round-trips.

### Project rooting

Every MCP tool takes a `projectRoot: string` parameter (per F2). The server treats this as the source of truth for path resolution; it never falls back to its own cwd, the calling client's cwd, or any per-connection state. Calls with mismatched or missing-layout `projectRoot` return `MissingFile`.

Multiple Claude Code clients connecting to the same long-lived server work concurrently against different projects without ambiguity: each call carries its own `projectRoot` and resolves independently.

### Versioning

`getApiVersion()` returns the current contract version. The version is bumped in lockstep with F2 changes. Per-file schema versions are independent.

### Distribution

Published to npm as `@claudeagents/config-server`. R2's installer runs `npm install -g @claudeagents/config-server` (or pinned version) and registers the binary as the MCP server in Claude Code's config.

### Logging

The server logs to a per-run file under `.gan-state/runs/<run-id>/logs/config-server.log` when invoked from a `/gan` run, and to stderr when invoked from the CLI. Logs include every tool call (function name, anonymised arguments, result code) for debugging without sensitive data.

### Minimum-viable observability surface

R1 produces the underlying data for [O1's startup log line](O1-resolution-observability.md) (part A) via `getResolvedConfig()`: which stack files were loaded, which tier each came from, which overlay tiers were loaded, which `additionalContext` files resolved, which fields were discarded by `discardInherited`. The orchestrator (E1's scope) consumes this data and emits the single-line / single-block console summary; phase ordering between R1's minimum surface and O1's richer JSON surface lives in the roadmap, not in this spec.

## Acceptance criteria

- The server binary starts via `claudeagents-config-server` (the npm bin entry); MCP-handshakes with stdio; advertises the F2 tool set.
- `getResolvedConfig()` returns a stable-shape JSON document for any valid project.
- `validateAll()` returns structured errors for fixtures with each error class (SchemaMismatch, InvalidYAML, MissingFile, InvariantViolation).
- `updateStackField()` preserves the stack file's free-form `conventions` markdown verbatim.
- A pairsWith consistency violation between a fixture's `src/modules/foo/` and `stacks/foo.md` is reported as a single `InvariantViolation` with both file paths cited.
- Per-tool unit tests cover every F2 function with at least one positive and one negative case.
- Integration tests cover at least: a clean web-node project, a polyglot web-node + synthetic-second project (per the multi-stack guard rail in the roadmap's Cross-cutting principles), a project with overlays at every tier, a project with a malformed overlay.

## Dependencies

- F1 (filesystem layout)
- F2 (API contract this implements)
- F3 (schema authority)
- C1, C2, C3, C4, C5 (data models and resolution algorithms)

## Bite-size note

Sprint slices, in order:

1. Server skeleton + MCP tool registration + `getApiVersion()`.
2. Read functions (`getResolvedConfig`, `getStack`, `getOverlay`, …) without writes or validation.
3. Validation pipeline (schema validation only).
4. Cross-file invariants.
5. Resolver (cascade + dispatch).
6. Write functions.
7. Logging + integration tests.
