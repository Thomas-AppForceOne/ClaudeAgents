# F5 — Config API surface coherence

## Problem

The first dogfooding session against the shipped F2 / F3 surface caught two failure modes where the Config API *lied to its callers*. Both shipped through code review and test discipline because each lived in a gap between two specs that nobody owned end-to-end:

1. **`trustApprove` cache staleness.** A user typed `[a]` at the trust prompt; the orchestrator called `trustApprove`, which returned `{mutated: true}` and persisted the new approval to the trust cache file. The very next `getResolvedConfig` call still reported `Untrusted` — the resolver's in-memory cache had not invalidated. The orchestrator re-prompted the user mid-run, asking for trust on a path the user had just approved seconds earlier. F2's snapshot-freshness rule covers the *orchestrator's* view (re-snapshot on `mutated: true`), but the resolver's internal caches sit BELOW the snapshot layer — and they had no invalidation contract at all. Both layers must work; only one was specified.

2. **`NotImplemented` tools advertised as if real.** The MCP `tools/list` response includes `getOverlayField` and `getStackConventions`. Both are `NotImplemented` stubs that throw a structured error on every call. An agent reads the JSON schema for those tools, calls them confident they exist, and gets `NotImplemented`. The agent has no way to distinguish "tool exists but produced this error for my inputs" from "tool was never real in this version." The schema authority discipline says runtime and schema must agree; here they don't.

These are different surface bugs with the same shape: **the Config API promises a state or capability that the implementation does not actually provide**. F5 closes both with one spec because they live at the same architectural boundary (the server's public surface) and the test infrastructure to verify them is shared.

F5 is the fifth spec under the **F** (foundation) phase code. It does not author a new function surface; it adds new behavioural contracts that sit alongside the existing F2 function surface and the existing F3 schema discipline. F2 and F3 are shipped specs and are not edited by F5 — F5 IS the spec a reader finds when they look up cache coherence or schema-runtime alignment, and the roadmap is the cross-reference layer.

## Proposed change

### Server-side cache coherence on state-mutating writes

Every Config API function whose return value carries `mutated: true` must invalidate the resolver's data caches **before returning**. The invalidation is not deferred, not lazy, and not opportunistic. Callers that issue a state-mutating write immediately followed by a read MUST see the post-write state. There is no "eventual consistency" window.

**Scope.** Cache invalidation fires for every state-mutating tool:

- All `set*` / `append*` / `removeFrom*` paths under `setOverlayField`, `setModuleState`, `appendToModuleState`, `removeFromModuleState`, `appendToOverlayField`, `removeFromOverlayField`, `appendToStackField`, `removeFromStackField`, `updateStackField`.
- `trustApprove`, `trustRevoke` (the trust-cache mutations).
- `registerModule` when its runtime probe writes durable state (rare; today `registerModule` is advisory and mutates nothing, but the contract holds for the day it does).

Read-only calls (`getResolvedConfig`, `getStack`, `getOverlay*`, `getActiveStacks`, `getMergedSplicePoints`, `getStackResolution`, `getStackConventions`, `getApiVersion`, `getTrustState`, `getTrustDiff`, `listModules`, `getModuleState`, `validateAll`, `validateOverlay`, `validateStack`) do not invalidate anything — they reuse the cache.

**Mechanism.** The resolver keeps a cache of resolved configuration data (today: `resolvedConfigCache`, `stackBodyCache`, `trustStateCache`). On any state-mutating call, the function clears every cache that could now be stale. Per-cache fine-grained invalidation is allowed but not required — clearing the whole cache is acceptable for v1.0 since reads are cheap and writes are rare. The contract is "no stale reads after a mutation," not "minimal cache churn."

**mtime-driven invalidation for hand-edits.** Users edit overlay and stack files by hand outside the API (per F2's "Configuration files are hand-editable" principle). A hand-edit bypasses the in-process cache invalidation path entirely. To catch this, every read path checks the mtime of every file backing the resolved configuration BEFORE returning a cached value. If any backing file's mtime has advanced past the cache's recorded mtime, the cache is invalidated and the read recomputes from disk.

The mtime check is a stat on every backing file. For a project with a typical overlay + one stack + one user-tier overlay, that's 3–5 stat calls per read. Stat is cheap (~microseconds); the check is unconditional on read.

**Failure to invalidate is a regression.** A test in `tests/config-server/integration/` exercises every state-mutating tool by:
1. Calling the tool to produce a known mutation.
2. Immediately calling a read path that would surface the mutation.
3. Asserting the read returns the post-mutation state.

A regression that re-introduced caching without invalidation would fail this test.

### Schema-runtime alignment for the MCP tool surface

The MCP `tools/list` response must advertise **only** tools whose runtime dispatch produces real behavior. Tools whose dispatch path is `NotImplemented` are filtered out of the response.

**Mechanism.** `buildToolList()` (the function that constructs the `tools/list` JSON response) inspects each registered tool's dispatch handler. Tools whose handler is the framework's `NotImplemented` sentinel (or whose handler throws a `ConfigServerError` with `code === "NotImplemented"` unconditionally on every input) are excluded from the advertised list.

**Affected today (v1.0).** Two tools are filtered out at v1.0 release: `getOverlayField` and `getStackConventions`. Both are placeholder stubs whose real implementations land in v1.1. Filtering them now means:

- Agents reading the tool list do not see these tools and do not attempt to call them.
- When v1.1 ships the real implementations, the filter naturally permits them through (the dispatch handler is no longer `NotImplemented`). No further code change required.

**Parameter-shape consistency.** v1.0 also audits the in-tree schemas at `schemas/api-tools-v1.json` against the runtime parameter validators in `src/config-server/tools/`. Any drift identified during the audit is fixed in place (schema or validator, whichever is authoritative for the tool). The audit is manual at v1.0; v1.1 makes it automatic (either codegen from validators OR a contract test that exercises each tool with deliberately-bad inputs and asserts the runtime error matches the schema's `required`-field list).

**Filtering is NOT a hiding mechanism.** The framework deliberately does not advertise tools the runtime won't honor. This is honesty, not concealment. The full inventory of "tools the framework intends to ship in some release" lives in F2's function surface table; the advertised `tools/list` is a strict subset (the currently-implemented tools).

### What F5 does not do

- Rewrite the resolver. The cache invalidation hooks attach to existing tool dispatch paths; the resolver's internal data structures stay as-is.
- Migrate or version the schema. F3's `schemaVersion` semantics are unchanged. F5 is a write-time discipline change (which tools appear in `tools/list`), not a schema change.
- Auto-detect drift between schema and runtime. v1.0 ships the surgical fix (filter + manual audit); v1.1 lands the generation / contract-test infrastructure.
- Change the `mutated` return semantics. F2's existing `{mutated: bool, reason?: string}` contract holds; F5 specifies what the SERVER does internally when `mutated: true`, not what callers receive.
- Address the trust-prompt UX or branching (F4 / R5 own that).

## Field encodings

F5 introduces no new schema-bearing types. The mtime field on the cache is an internal implementation detail; no exposure to callers. The `NotImplemented` sentinel is an internal handler-classification convention, not a public type.

The runtime-knob inventory in `runtime-knobs.md` gains no new surfaces — both behaviors are invisible to the user (the cache is internal; the tool filter changes only which tools appear in `tools/list`, not how the user interacts with the framework).

## Examples

### Cache invalidation after `trustApprove`

Before F5:

```
$ /gan "first sprint"
…trust prompt fires…
[a]
…orchestrator calls trustApprove → returns {mutated: true}…
…orchestrator captures snapshot via getResolvedConfig…
…snapshot reports trustState: "Untrusted"  ← STALE; the cache did not invalidate
…orchestrator re-prompts the user for the same approval it just persisted…
```

After F5:

```
$ /gan "first sprint"
…trust prompt fires…
[a]
…orchestrator calls trustApprove → returns {mutated: true}…
  ← resolver cache invalidated synchronously before trustApprove returns
…orchestrator captures snapshot via getResolvedConfig…
…snapshot reports trustState: "Trusted"  ← correct; fresh read from disk
…sprint proceeds…
```

### MCP `tools/list` excludes `NotImplemented` stubs

Before F5:

```json
{
  "tools": [
    { "name": "getResolvedConfig", "inputSchema": { ... } },
    { "name": "getStack", "inputSchema": { ... } },
    { "name": "getOverlayField", "inputSchema": { ... } },   ← NotImplemented stub
    { "name": "getStackConventions", "inputSchema": { ... } }, ← NotImplemented stub
    { "name": "setOverlayField", "inputSchema": { ... } },
    ...
  ]
}
```

After F5:

```json
{
  "tools": [
    { "name": "getResolvedConfig", "inputSchema": { ... } },
    { "name": "getStack", "inputSchema": { ... } },
    { "name": "setOverlayField", "inputSchema": { ... } },
    ...
  ]
}
```

No `getOverlayField` and `getStackConventions` until their real implementations land.

### Hand-edit detected by mtime check

```
$ vim ~/.claude/gan/config.md    # user edits an overlay by hand
…
$ /gan --print-config              # in same Claude Code session, before /gan re-snapshot
…getResolvedConfig called…
  ← mtime check: overlay file mtime > cache.mtime
  ← invalidate cache, recompute from disk
…snapshot includes the hand-edit, not the pre-edit state…
```

## Acceptance criteria

### Automated checks

- After `trustApprove`, an immediate `getResolvedConfig` call returns `trustState: "Trusted"` (or whatever the post-approval state is). Test asserts this for every state-mutating tool: `setOverlayField`, `setModuleState`, `appendToModuleState`, `removeFromModuleState`, `appendToOverlayField`, `removeFromOverlayField`, `appendToStackField`, `removeFromStackField`, `updateStackField`, `trustApprove`, `trustRevoke`. The shape of the test is "call mutator → call reader → assert reader sees the mutation."
- After a hand-edit to a tracked overlay or stack file (simulated by `fs.writeFileSync` + setting the mtime forward), the next read path returns the post-edit state without an explicit invalidation call.
- The MCP `tools/list` response does NOT include `getOverlayField` or `getStackConventions` while their dispatch paths remain `NotImplemented`.
- The MCP `tools/list` response DOES include `getOverlayField` and `getStackConventions` once their dispatch paths produce real responses (i.e., the filter is keyed off the dispatch, not a hardcoded denylist). Verified via a test that swaps in a fake real-implementation dispatch and asserts the tool now appears.
- The runtime parameter-shape audit's findings (if any) are folded into either `schemas/api-tools-v1.json` or the corresponding validator under `src/config-server/tools/`; the schema and the validator agree on every tool's required-field list at v1.0 release.
- `npx vitest run` passes; `npx tsc --noEmit` is clean.

### Manual review checks

- The cache-invalidation hook is attached to every state-mutating tool dispatch path, not just to a subset. A grep across `src/config-server/tools/writes.ts` and the trust-cache paths confirms every mutation route invalidates.
- The `tools/list` filter implementation is centralised (one place, one rule) rather than scattered (per-tool boolean flags). When `getOverlayField` ships in v1.1, no F5 code needs to change.
- The F5 prose names F2 and F3 as the upstream contracts F5 builds on. Per the "Implemented specs are immutable" rule, F2 and F3 themselves are not edited; readers of F2 or F3 find F5 via the roadmap entry.

## Dependencies

- **F2** — the function surface whose `mutated:true` semantics F5 builds on. F2 is a shipped spec and is not edited by F5; F5's contracts are read as additions, with the roadmap providing the cross-reference.
- **F3** — the schema-authority discipline F5's tool-list filter completes for v1.0. F3 is shipped and is not edited; F5's "Schema-runtime alignment for the MCP tool surface" lives in F5 alone.
- **R1** — the reference MCP server implementation; F5 lands in `src/config-server/`.
- **R5** — trust-cache implementation; the `trustApprove` / `trustRevoke` paths are F5's most-cited example of the cache-staleness bug.

## Bite-size note

Sprintable as:

1. (small) **`NotImplemented` filter in `tools/list`.** One-line filter in `buildToolList()`. Test asserts the two affected tools are absent at v1.0 and present once a real dispatch handler is swapped in.
2. (medium) **Cache invalidation on state-mutating writes.** Identify every mutating dispatch path; attach a `resolver.invalidate()` call at the end of each before return. Tests are one per mutating tool — call the mutator, call a read, assert fresh state.
3. (small) **mtime-driven invalidation on reads.** Add an mtime check to the read paths. Test simulates a hand-edit by writing a file with a forward-shifted mtime and asserting the next read picks up the change.
4. (small) **Parameter-shape audit.** Walk every entry in `schemas/api-tools-v1.json` against its matching validator under `src/config-server/tools/`. Fix any drift in place. If no drift exists, log the audit result in the run notes and move on.

Slices 1–3 are independent; slice 4 is the closing audit.

## Out of scope

- **Generation or contract tests for schema-runtime alignment.** v1.1 work. v1.0 is surgical (filter + audit); v1.1 makes the alignment automatic per the cross-cutting principle.
- **Per-key cache invalidation.** v1.0 invalidates the whole resolver cache on any mutation. Per-key invalidation (e.g., a stack-file edit only flushes the affected stack body) is a performance optimisation deferred until profiling shows it matters.
- **Hand-edits to module-state files** (`.gan-state/modules/<name>/<key>.json`). Module state is zone-2 ephemeral; the contract does not promise mtime-detection there. If a user hand-edits module state, they are operating outside the framework's contract and the framework does not guarantee they see the edit on the next read.
- **External cache layers.** F5 covers the in-process resolver cache. If a future release introduces a cross-process cache (e.g., a daemon), that release's spec must cover its coherence rules; F5 does not pre-author them.
