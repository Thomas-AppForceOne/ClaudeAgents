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
  api-tools-v1.json
  …
```

Naming: `<file-type>-v<N>.json`, where `<file-type>` is the kind of config file and `<N>` is the schemaVersion the document describes.

Each domain spec authors the JSON Schema for its file type as part of its content (C1 owns `stack-v1.json`, C3 owns `overlay-v1.json`, M1 owns `module-manifest-v1.json`). The schema document is the authoritative declarative description; English prose in the spec is illustrative only.

`api-tools-v1.json` is the parameter-shape schema for every MCP tool the reference server exposes (per F2's function surface and R1's MCP tool registration); it is owned by R1 because tool parameter shapes track the implementation surface, not a content-file format. Listed here for completeness so the on-disk schema set is enumerated in one place.

### `schemaVersion` semantics

Every config file declares `schemaVersion` in its frontmatter. The API enforces:

1. **Exact match required.** Readers fail on any version they do not understand. No compatibility ranges. No graceful downgrade. No forward-compat reads.
2. **Pre-1.0 WIP rule:** any schema change bumps the version. Additive changes do not get a free pass. This applies across the whole framework while the project is pre-1.0.
3. **Schema documents are immutable once published.** To change a schema, write a new `<file-type>-v<N+1>.json` and bump consumers in lockstep.

The API knows which versions it can read; this is part of its compiled-in metadata. An R1 instance built against `schemas/stack-v1.json` reads stack files with `schemaVersion: 1` and rejects any other version with a `SchemaMismatch` error.

### Migration tooling — deferred to first schema bump

Exact-match-required + frequent version bumps = real friction for users whose committed `.claude/gan/project.md` and `.claude/gan/stacks/*.md` files break on every framework update. v1 ships only `schemaVersion: 1` for every file type — there is no v0 to migrate from, so a migration tool would have nothing to do.

The migration-tooling spec (provisional name `gan migrate-overlays`) is authored **at the same time as the first schema bump**, not before. Authoring it now would mean encoding assumptions about how schemas evolve (renamed fields, restructured values, additive vs. non-additive bumps) before any real evolution has happened. Better to write the tool against a concrete v1 → v2 transition where the actual transformation is known.

What v1 commits to: when the first schema bump lands, the bumping PR includes both the new schema document (`<type>-v2.json`) and the migration tool. Users get a `gan migrate-overlays --to=2` (or whatever the surface ends up being) at the moment they need it. Out-of-band release-note migrations are not the answer.

### Determinism (canonical)

Several pieces of the framework depend on byte-identical output across machines: schema validation, cross-file invariant checks, the evaluator pipeline harness's golden-file diffs, the trust hash, R4's lint scripts, the resolver cache keying. Each one of those previously documented its own determinism rules; consolidated here so there is one canonical specification and the rest reference it.

The framework pins:

- **Glob matching:** [picomatch](https://github.com/micromatch/picomatch) at a major version pinned in R1's `package.json`. Picomatch is chosen over `minimatch` and `node-glob` for its documented escape and brace-expansion semantics. Any spec that performs glob matching uses this library.
- **Path canonicalisation:** at every API boundary that takes a path-like argument (F2's `projectRoot`, R5's trust-cache `projectRoot` keying, U3's `additionalContext` resolution, F4's `PathEscape` invariant), paths are canonicalised by: `fs.realpathSync.native(path)` (Node) or its equivalent; trailing slash stripped; case-insensitive filesystem normalisation by canonical-path comparison; missing paths produce `MissingFile` (or the spec-specific equivalent) before any further work. Two semantically-equivalent paths must canonicalise to the same key.
- **JSON output:** stable formatting with sorted object keys, two-space indent, trailing newline. `JSON.stringify` with a small in-tree sort helper; no external library. This is the format for resolved-config snapshots, evaluator-plan goldens, trust-cache contents, and any other JSON the framework writes for diff or comparison.
- **File enumeration order:** every input file list (`fs.readdirSync` results, glob expansions, fixture file walks) is sorted by `String.prototype.localeCompare(other, undefined, { sensitivity: 'variant', numeric: false })` before any first-match-wins logic sees it. APFS / ext4 / NTFS readdir orders differ; the sort makes them irrelevant.
- **Regex engine:** Node's V8-based RegExp. Behavior is stable per Node version. R1's `package.json` pins the Node engine range alongside the picomatch version.

The trust-cache hash is determinism-relevant but implementation-specific to the trust model; its algorithm and "raw bytes, no normalisation" rule live in R5, not here.

Specs that depend on any of these rules **reference this section** rather than restating. Diverging from any pin in a future revision is a coordinated change across every dependent spec, gated by a re-run of the evaluator pipeline harness's `--update-goldens` flag and a corresponding R5 trust-cache invalidation.

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
| `path.escape` | F4 | Every path declared in any committed config file (today: `planner.additionalContext`, `proposer.additionalContext`; future splice points must be added) resolves to a real path that is a descendant of the project root. Symlinks pointing outside the root are escapes. Hard error (`PathEscape`). |
| `trust.approved` | F4 | If any committed file contains a command-declaring field and the project's content hash is not in the trust cache, validation fails with `UntrustedOverlay`. `GAN_TRUST=unsafe-trust-all` opts out. |
| `overlay.tier_apiVersion` | C3 | Each overlay tier's `schemaVersion` matches the API's known overlay schema version. |
| `stack.tier_apiVersion` | C1 | Each active stack file's `schemaVersion` matches the API's known stack schema version. |
| `detection.tier3_only` | C5 | A `detection` block is permitted only in tier-3 (canonical / repo) stack files. A tier-1 (project) or tier-2 (user) stack file containing a `detection` block fails with a hard `InvariantViolation` error. Silent-drop is rejected: a project-tier file's "detection" reading as docs but never activating would be a footgun. C1's schema additionally forbids `detection` outside tier 3 at parse time; this cross-file invariant is the authoritative gate. |
| `stack.no_draft_banner` | R3 | A stack file at any tier whose first non-blank line is the literal `# DRAFT — replace TODOs and remove this banner before committing.` banner emitted by `gan stacks new` (R3) fails with a hard `InvariantViolation` error citing the path. The banner is the scaffold's "you're not done yet" signal; removing it is the user's deliberate "I have replaced the TODOs" act. Catalogued as a cross-file invariant so it fires at *both* runtime via `gan validate` / `validateAll()` *and* at build time via R4's `lint-stacks` — without two separate code paths having to agree on the rule. |

Invariants are implemented in code (R1) but live conceptually here so the catalog is centralised.

**Single point of implementation.** Each invariant has one implementation in R1. R4's lint scripts that need to check invariants at build time **import R1's check function** rather than re-implementing — the same code path, called from a different entry point. This eliminates the drift risk a multi-implementation pattern would introduce: a rule can never silently differ between `gan validate` (runtime) and the maintainer-side lint (build time) because they call the same function. The invariants currently subject to this rule (most prominently `pairsWith.consistency`, `cacheEnv.no_conflict`, and `path.escape`, which span multiple consumer specs) all funnel through R1's invariant module; specs that catalogue or motivate a rule (C1, C5, M1, F4) do not duplicate the implementation.

### Versioning across axes

The framework tracks four independent version axes. They evolve on different cadences. This subsection reconciles them so reviewers and implementers can see the whole picture in one place.

| Axis | Owner | Bumps when… | Read by | Authoritative spec |
|---|---|---|---|---|
| **Per-file `schemaVersion`** | F3 + each domain spec (one per file type) | Any change to a `schemas/<type>-vN.json` document. | The API at file load; lint at CI time. | F3 |
| **API contract version** | F2 | F2's function surface, parameter shapes, return shapes, or structured-error model changes in any way. | Agents, CLI, third-party tooling via `getApiVersion()`. | F2 |
| **MCP protocol version** | Anthropic's MCP spec | The MCP spec itself revises. | The MCP transport handshake. | external (Anthropic) |
| **npm package semver** | R1 | Any release of `@claudeagents/config-server`, by usual semver rules — major bump for breaking API or schema changes, minor for additive, patch for fixes. | npm registry, `install.sh`. | R1 |

Bump propagation rules:

- A bump on the **API contract version** forces a major npm bump (the package's externally-visible behavior changed).
- A bump on **any per-file schemaVersion** is internal to the package. The npm version may still bump (major if the bump removes a field; minor if additive) but the api contract version need not.
- An **MCP protocol bump** is forced upon the framework by the host. R1 must support the MCP versions Claude Code supports; agents and CLI inherit transparently.
- The four axes are otherwise orthogonal. A schema can bump without an API-contract bump, and vice versa.

Mismatches:

- API contract mismatch (caller version ≠ server version): structured `UnknownApiVersion` error from F2.
- File schemaVersion mismatch: structured `SchemaMismatch` error with file path and both versions.
- MCP protocol mismatch: handled by the MCP transport layer; surfaces as a connection failure to the user.
- npm semver: the install path's concern; users and CI pin via `package.json` ranges.

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
