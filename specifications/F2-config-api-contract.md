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

### Project rooting

Every API function takes an explicit `projectRoot: string` parameter (an absolute path to the project the call resolves against). This is mandatory, not optional.

Rationale: the MCP server is long-lived and may be reached by multiple Claude Code clients across multiple projects in a single session. Relying on the server's cwd, the calling client's cwd, or any implicit per-connection state is brittle (MCP does not carry cwd in the protocol). An explicit `projectRoot` argument is verbose for the caller but unambiguous; it is the only sound choice given the long-lived-server design.

**Path canonicalisation is mandatory at the API boundary.** Before any read, write, or trust-cache lookup, the server canonicalises `projectRoot`:

- Resolve symlinks (`fs.realpathSync.native` on Node).
- Strip trailing slashes.
- Normalise on case-insensitive filesystems by canonical-path comparison (so `/Users/Thak/x` and `/Users/thak/x` resolve to one key on macOS).
- Reject paths that don't exist on disk with a `MissingFile` structured error.

Two API calls with semantically-equivalent paths must resolve to the same canonical form. Without this rule, `getResolvedConfig("/x/proj")` and `getResolvedConfig("/x/proj/")` could differ in trust state — a footgun the canonicalisation closes.

In practice, the orchestrator (E1) captures `projectRoot` once per `/gan` run and includes it in every API call it makes. Agents consume the snapshot and rarely call the API directly; when they do, they receive `projectRoot` from the orchestrator's context. The CLI (R3) takes `--project-root` defaulting to the canonical form of the current working directory; trust-mutating commands (per R3) require `--project-root` explicitly.

A function called with a `projectRoot` that does not contain the framework's expected directory layout (no `.claude/gan/`, no usable repo root) returns a structured `MissingFile` error rather than searching upward.

**Capability binding is out of scope for v1.** Any caller can pass any `projectRoot`. The trust model assumes orchestrator-controlled values: the orchestrator is the only direct caller in a `/gan` run, and it captures `projectRoot` from the host environment. If a future feature surfaces a user-influenced string into a `projectRoot` argument (e.g. "operate on this subtree" or any tool-injection vector), the API will dutifully resolve and may approve where it should not. There is no signed token. This is **acceptable for pre-1.0 and explicitly flagged for the post-R audit** so it is reviewed once R1's caller graph is concrete.

### Function surface

Function names are camelCase with a verb prefix. Every function takes `projectRoot` as its first argument; the tables below omit it for readability but it is required.

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
| `getTrustState()` | Whether the current `(projectRoot, content-hash)` is approved per F4; diff details if not. |

**Writes:**

| Function | Effect |
|---|---|
| `updateStackField(name, field, value)` | Validates the change against the stack schema and any cross-file invariants, then persists. Refuses inconsistent state. For list-shaped fields, this is a wholesale replacement; prefer `appendToStackField` / `removeFromStackField` for collection edits. |
| `appendToStackField(name, field, value)` | Atomic append for list-shaped fields. Reads the current list, appends `value` (with a duplicate-policy parameter: `error` / `skip` / `allow`), validates, persists. Avoids the read-modify-write race that bare `updateStackField` would expose. |
| `removeFromStackField(name, field, key)` | Atomic remove for keyed-list-shaped fields (`securitySurfaces` by `id`, etc.). |
| `setOverlayField(path, value, tier="project")` | Updates a single splice point at the named tier. Tier defaults to project. |
| `setModuleState(moduleName, key, value)` | Writes a durable module-state value to zone 2. Whole-value replacement; prefer `appendToModuleState` / `removeFromModuleState` for list- or map-shaped state. |
| `appendToModuleState(moduleName, key, entry, duplicatePolicy="error")` | Atomic append for list- or map-shaped module-state values. Same R-M-W-race avoidance as `appendToStackField`. Required for shapes like M2's `PortRegistry` where two concurrent `/gan` runs may both register a port. |
| `removeFromModuleState(moduleName, key, entryKey)` | Atomic remove for keyed list- or map-shaped module-state values. |
| `registerModule(moduleName, manifest)` | Records a module's `pairsWith` and capabilities. Refuses inconsistent pairing. |
| `trustApprove(contentHash, note?)` | Records approval of the current content hash for this project. Per F4. |
| `trustRevoke()` | Removes any trust approval for this project. Per F4. |

**Concurrency.** The MCP server is the sole writer to all framework files. Within a single `/gan` run, agents execute serially under orchestrator control; no two agents in one run modify the same field. The R-M-W race that would arise from concurrent `getStack()` + `updateStackField()` calls is **not** exposed by the framework's normal use pattern. For exotic external callers (e.g. a script using R3 in a multi-process setup), the dedicated `appendToStackField` / `removeFromStackField` / `appendToModuleState` / `removeFromModuleState` operations preserve atomicity.

**A narrow user-editor race remains.** A user save into `.claude/gan/project.md` between the server's load step and persist step of a write is not locked against. The window is sub-millisecond on the server side and the framework's design point is "user edits are external state; the server is single-writer for its own files," so adding cross-process locking for this case would be over-engineering. If the race fires, the server's persist step overwrites the user's save (the server holds the load it validated against). Documented here so reviewers see it; not a fix candidate for v1.

**Write functions return a mutation indicator.** Every write function — `updateStackField`, `appendToStackField`, `removeFromStackField`, `setOverlayField`, `setModuleState`, `appendToModuleState`, `removeFromModuleState`, `registerModule`, `trustApprove`, `trustRevoke` — returns `{ mutated: true | false, ...result }`. `mutated: true` means the call changed durable state (file content or trust cache); `false` means the call succeeded but was a no-op (e.g. `appendToStackField` with `duplicatePolicy="skip"` and the entry already present). The orchestrator uses this flag to drive the re-snapshot rule below; agents do not need to inspect it. Read functions never return a `mutated` field.

**Validation:**

| Function | Effect |
|---|---|
| `validateAll()` | Full pipeline: per-file schema validation, cross-file invariants, trust check (per F4). Returns OK or a structured report. Idempotent; safe to call repeatedly. |
| `validateStack(name)` | Single-stack schema check. |
| `validateOverlay(tier)` | Single-tier overlay schema check. |

### MCP binding

Each function in this spec is an MCP tool. Tool names mirror function names. Parameter schemas are JSON Schema documents (per F3). Returns are structured JSON.

The MCP server is a long-lived process while the host (Claude Code) is open. R2's installer registers it once; thereafter it is available to every `/gan` invocation.

**Modules do not register their own MCP tools.** Modules (per M1) are runtime utility libraries; their state is read and written through the existing `getModuleState`/`setModuleState`/`registerModule` tools, keyed by module name. MCP does not generally support dynamic per-module tool registration mid-session, and the framework does not need it: every per-module operation routes through the shared tool surface above. A reader who sees `M2's PortRegistry` and wonders if Docker exposes its own MCP tools — it does not.

### Validation timing

The orchestrator's first action on a `/gan` invocation is `validateAll()`. This runs before:

- Worktree creation.
- Sprint plan generation.
- Any agent invocation.
- Any write to zones 2 or 3.

On failure, the run aborts and no state is written; the user sees the structured report. On success, the orchestrator calls `getResolvedConfig()` once, captures the snapshot, and passes it to every spawned agent. Agents do not re-validate.

**Snapshot freshness across sprints.** The captured snapshot is frozen for the entire `/gan` run, including across multiple sprints in a multi-sprint plan. Wall-clock time between sprints does not matter; user edits to overlay or stack files mid-run are *not* picked up until the next `/gan` invocation. The orchestrator does **not** re-snapshot between sprints to catch user edits.

This is a deliberate consistency choice: a sprint contract issued in sprint N must remain meaningful when evaluated in sprint N+1. If a user wants config changes to take effect, they abort the run and start a new `/gan`.

**Agent-driven mutations re-snapshot deterministically.** When an agent writes via the API (any of the write functions enumerated above), the write returns `{ mutated: true, ... }` if the call changed durable state. The orchestrator records the per-sprint OR of every agent's `mutated` flags; if any agent in the prior sprint produced `mutated: true`, the orchestrator **always** re-snapshots before spawning the next agent. There is no "may" — re-snapshot-after-true-mutation is unconditional. A `mutated: false` result (e.g. duplicate-skip append) does not trigger a re-snapshot, since durable state is unchanged. This makes downstream-agent visibility deterministic: an agent that mutates state can rely on the next agent in the sprint sequence seeing the new state. (The agent doing the write also sees the post-write state via the function's return value, but that is local to the call.)

The combination — frozen across user edits, re-snapshotted after agent writes — gives the system a predictable two-tier freshness contract: external state is stable for the run; internal state advances on agent action.

### Error model

All errors are structured objects:

```json
{
  "code": "SchemaMismatch | InvalidYAML | MissingFile | UnknownStack | UnknownSplicePoint | InvariantViolation | ValidationFailed | UnknownApiVersion | UntrustedOverlay | TrustCacheCorrupt | PathEscape",
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
