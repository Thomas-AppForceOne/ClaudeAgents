# F2 — Configuration API contract

## Problem

Agents in `/gan` currently parse files directly: read stack files, parse YAML, apply detection, resolve overlay cascades. This forces every agent to know storage layout, schema versions, file formats, and merge logic. As the framework grows, the duplication scales poorly and every storage change ripples through every agent.

The Configuration API decouples agents from configuration storage. Agents become API clients: they know function names and argument shapes; they do not know where data lives, what format it is in, how it is merged, or how it is validated.

## Proposed change

A stable function contract used by agents and the CLI alike. Language-neutral; reference implementation is a Node 18+ MCP server (R1).

### Design principles

1. **Black box.** Callers see function names, argument shapes, and return types. They do not see file paths, parsers, schema versions, merge logic, or storage mechanisms.
2. **Bulk reads.** Reads return complete structured snapshots. No per-field getter chatter.
3. **Targeted writes.** Writes are field-scoped and validate before persisting.
4. **One validation pass per `/gan` run.** The skill orchestrator calls `validateAll()` before any agent runs. Failure aborts the run before worktree creation. Success captures a snapshot every spawned agent reuses; agents do not re-validate.
5. **Hand-edits remain valid.** Users edit files in their editor. Readers validate at load time and error on malformed files. The API is the sanctioned write path, not the only one.
6. **Free-form prose is read-only via the API.** Stack-file `conventions` sections are exposed through `getStackConventions()` but have no setter. To edit prose, open the file.

### Function surface

Function names are camelCase with a verb prefix.

**Reads:**

| Function | Returns |
|---|---|
| `getResolvedConfig()` | Full resolved view: active stacks, merged splice points, additionalContext paths, validation status, API version. |
| `getActiveStacks()` | List of `{name, tier, schemaVersion}` for every active stack. |
| `getStack(name)` | Full structured stack data (detection, scope, secretsGlob, cacheEnv, auditCmd, buildCmd, testCmd, lintCmd, securitySurfaces, schemaVersion). |
| `getStackConventions(name)` | Free-form markdown text from the stack file's conventions section, or null. |
| `getOverlay()` | Resolved overlay view across default → user → project (per C4). |
| `getOverlayField(path)` | Single resolved value at a dotted path (e.g. `"runner.thresholdOverride"`). |
| `getModuleState(moduleName, key)` | Durable state value for a module from F1 zone 2. |
| `listModules()` | Registered modules with `pairsWith` status. |
| `getApiVersion()` | API contract version this server implements. |

**Writes:**

| Function | Effect |
|---|---|
| `updateStackField(name, field, value)` | Validates the change against the stack schema and any cross-file invariants, then persists. Refuses inconsistent state. |
| `setOverlayField(path, value, tier="project")` | Updates a single splice point at the named tier. Tier defaults to project. |
| `setModuleState(moduleName, key, value)` | Writes a durable module-state value to zone 2. |
| `registerModule(moduleName, manifest)` | Records a module's `pairsWith` and capabilities. Refuses inconsistent pairing. |

**Validation:**

| Function | Effect |
|---|---|
| `validateAll()` | Full pipeline: per-file schema validation, then cross-file invariants. Returns OK or a structured report. Idempotent; safe to call repeatedly. |
| `validateStack(name)` | Single-stack schema check. |
| `validateOverlay(tier)` | Single-tier overlay schema check. |

### MCP binding

Each function is an MCP tool. Tool names mirror function names. Parameter schemas are JSON Schema documents (per F3). Returns are structured JSON.

The MCP server is a long-lived process while the host (Claude Code) is open. R2's installer registers it once; thereafter it is available to every `/gan` invocation.

### Validation timing

The orchestrator's first action on a `/gan` invocation is `validateAll()`. This runs before:

- Worktree creation.
- Sprint plan generation.
- Any agent invocation.
- Any write to zones 2 or 3.

On failure, the run aborts and no state is written; the user sees the structured report. On success, the orchestrator calls `getResolvedConfig()` once, captures the snapshot, and passes it to every spawned agent. Agents do not re-validate.

**Snapshot freshness across sprints.** The captured snapshot is frozen for the entire `/gan` run, including across multiple sprints in a multi-sprint plan. Wall-clock time between sprints does not matter; user edits to overlay or stack files mid-run are *not* picked up until the next `/gan` invocation. The orchestrator does **not** re-snapshot between sprints.

This is a deliberate consistency choice: a sprint contract issued in sprint N must remain meaningful when evaluated in sprint N+1. If a user wants config changes to take effect, they abort the run (Ctrl-C or the existing abort path), edit, and start a new `/gan`. Agent-driven mutations through API write functions are the one exception — when an agent writes via the API, the orchestrator may re-snapshot before spawning the next agent.

### Error model

All errors are structured objects:

```json
{
  "code": "SchemaMismatch | InvalidYAML | MissingFile | UnknownStack | UnknownSplicePoint | InvariantViolation | ValidationFailed | UnknownApiVersion",
  "file": "<path or null>",
  "field": "<dotted-path or null>",
  "line": "<int or null>",
  "column": "<int or null>",
  "message": "<human-readable>",
  "remediation": "<short suggested fix or null>"
}
```

Error messages never reference maintainer-only scripts (per the roadmap's user-facing discipline rule).

### Markdown body split

Stack files and overlay files are markdown documents with a YAML body block.

- **Structured YAML body block:** owned by the API. Read via `get*` functions, written via `set*` / `update*` functions. Schema-validated.
- **Free-form markdown** outside the YAML block: hand-edit only. Stack `conventions` sections are exposed read-only via `getStackConventions(name)`.

The API never writes prose. When an updater modifies a stack file, prose outside the YAML block is preserved verbatim; only the YAML block is rewritten.

## Acceptance criteria

- Every agent in `/gan` obtains its working configuration from `getResolvedConfig()` (or a snapshot the orchestrator captured from it). No agent reads stack files, overlay files, or schema documents directly.
- The orchestrator's first action on a run is `validateAll()`; failure aborts the run before worktree creation.
- Agents that produce changes to stacks or overlays do so through write functions, never by writing files.
- A user editing `.claude/gan/project.md` and saving a malformed file produces a structured error from the next `/gan` run's `validateAll()` call; the run does not proceed.
- A stack file's `conventions` section is preserved verbatim across an `updateStackField()` call that changes a different field.
- Error messages from any API function never reference maintainer-only scripts.
- The MCP server advertises its supported API version via `getApiVersion()`; an agent or CLI receiving a mismatched version produces a structured `UnknownApiVersion` error.

## Dependencies

- F1 (filesystem layout — what the API stores into).

F3 (schema authority) is referenced throughout this spec as the source of validation rules, but F2's contract can be authored without F3 being authored first; the implementation in R1 is what depends on both.

## Bite-size note

F2 is contract-only — a single document, one sprint of authoring. Implementation slicing belongs in R1, which has its own bite-size note describing the sprint sequence.
