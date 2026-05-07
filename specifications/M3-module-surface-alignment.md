# M3 — Module surface alignment

## Problem

Three F2/M1 divergences were discovered during the post-M revision-break audit (see `roadmap.md`'s "Revision break — post-M module surface audit" section). M1's implementation silently dropped F2's `key` parameter from `getModuleState` / `setModuleState`, dropped the `duplicatePolicy` argument from `appendToModuleState`, and reinterpreted `removeFromModuleState` to take a `value` (deep-equal match) instead of an `entryKey` (keyed lookup).

The audit closed with F2 winning on all three. Each divergence requires a code change to bring M1's runtime surface back in line with the spec. None can ship as-is without leaving the module-state contract permanently misaligned with F2; together they form one coherent alignment sprint that must land before Phase 5 begins.

## Proposed change

Restore F2's per-key module-state contract end-to-end. The Configuration API's module-state surface gains the `key` parameter on every function, the on-disk layout splits one blob per key, the manifest's `stateKeys` array becomes an authoritative allowlist, `appendToModuleState` honours `duplicatePolicy`, and `removeFromModuleState` uses keyed lookup.

### Storage layout

Change the on-disk state layout under `.gan-state/modules/<name>/`:

| Today (M1 shortcut) | After M3 |
|---|---|
| `state.json` (one whole-blob file per module) | `<key>.json` (one file per declared `stateKeys` entry) |

Concrete example for the docker module (whose manifest declares `stateKeys: ["port-registry"]`):

```
Before:  .gan-state/modules/docker/state.json
After:   .gan-state/modules/docker/port-registry.json
```

A module that adds a second key (e.g. `build-cache`) in a later release adds the entry to its manifest, then writes through `setModuleState('docker', 'build-cache', …)` which lands at `.gan-state/modules/docker/build-cache.json`.

The `<name>/` directory is created on first write to any of its keys; per-key files are created lazily.

### API signatures

The Configuration API's module-state surface gains the `key` parameter (matching F2's table verbatim):

| Function | F2-locked signature | Behaviour |
|---|---|---|
| `getModuleState(moduleName, key)` | Read the named key's blob; return `null` if the file is absent. |
| `setModuleState(moduleName, key, value)` | Whole-value replacement of the named key's blob. Atomic write to `.gan-state/modules/<name>/<key>.json`. |
| `appendToModuleState(moduleName, key, entry, duplicatePolicy="error")` | Atomic append for list-/map-shaped values at the named key. `duplicatePolicy` is one of `"error"` (reject duplicate, return `{mutated: false, reason: 'duplicate-entry'}`), `"skip"` (no-op on duplicate, return `{mutated: false, reason: 'duplicate-entry'}`), `"allow"` (append unconditionally). Default `"error"`. |
| `removeFromModuleState(moduleName, key, entryKey)` | Atomic remove keyed by `entryKey`. The shape stored at the key must be either a map (`Record<string, unknown>`) where `entryKey` matches the property name, or a list of `{key: string, …}` records where `entryKey` matches the `key` field. Removing a non-existent `entryKey` is a no-op (`{mutated: false, reason: 'entry-not-found'}`). |
| `registerModule(moduleName, manifest)` | Unchanged from the post-M F2 revision: a runtime probe; manifest argument advisory. |
| `listModules()` | Unchanged. |

### `stateKeys` allowlist enforcement

The manifest's `stateKeys` array is the authoritative declaration of valid keys for the module. The Configuration API enforces this on every write:

- `setModuleState`, `appendToModuleState`, `removeFromModuleState` all validate that `key` is a member of the named module's `stateKeys` before any I/O.
- An undeclared `key` is rejected with a structured `ConfigServerError` whose `code === "UnknownStateKey"` and whose message names both the module and the offending key.
- `getModuleState` against an undeclared `key` returns `null` (consistent with "no file" behaviour) — a read does not need to fail loudly because there's no risk of corrupting state, and tooling that probes for keys is a legitimate use case.
- A module whose manifest omits `stateKeys` cannot persist any state. `setModuleState` calls against it always reject with `UnknownStateKey`. (Modules that need no persistent state simply never call the API.)

### `duplicatePolicy` semantics

`appendToModuleState`'s third positional argument matches the convention already established by `appendToOverlayField` and `appendToStackField`:

- `"error"` (default): if the entry is already present (deep-equal match against existing list members, or property already present for map shapes), return `{mutated: false, reason: 'duplicate-entry'}` and do not write.
- `"skip"`: same outcome (`{mutated: false, reason: 'duplicate-entry'}`) but semantically "I expected this might already be there."
- `"allow"`: append unconditionally even on duplicate; useful for log-shaped state where order and repetition matter.

The shape rules: if the stored value is a list, deep-equal compares list members; if it's a map keyed by string, the duplicate check is by key (the existing value at that key counts as a duplicate). If the stored value is neither a list nor a map, `appendToModuleState` rejects with `MalformedInput` (the operation has no defined meaning).

### `removeFromModuleState` lookup

Replaces M1's deep-equal value match with keyed lookup. The function takes `entryKey: string`, not `value: unknown`.

- For map-shaped state at the key: `entryKey` matches the property name; remove that property.
- For list-shaped state at the key: each list member must be an object with a `key: string` field; `entryKey` matches that field; remove the matching member. (List members without a `key` field cannot be addressed by `removeFromModuleState`; a module that needs to remove unkeyed list entries should `setModuleState` the list back with the entry filtered out.)
- Non-existent `entryKey` is a no-op (`{mutated: false, reason: 'entry-not-found'}`).
- Empty list / empty map after removal stays as `[]` / `{}` (no auto-delete of the file).

### PortRegistry update

The docker module's `PortRegistry` utility already routes persistence through `setModuleState` and `loadModuleState`. Under M3 it gains the `key` argument:

```ts
// Before (M1 shortcut)
setModuleState({projectRoot, name: 'docker', state: registry});

// After (M3)
setModuleState({projectRoot, moduleName: 'docker', key: 'port-registry', value: registry});
```

The on-disk file changes from `.gan-state/modules/docker/state.json` to `.gan-state/modules/docker/port-registry.json`. PortRegistry's public surface (`register`, `lookup`, `getAll`, `release`) is unchanged.

### Test updates

The module-state tests added in #6 must be updated to thread the `key` parameter through every call:

- `tests/config-server/tools/writes.test.ts` — every `setModuleState` / `appendToModuleState` / `removeFromModuleState` test gains a `key` argument; new test for `UnknownStateKey` rejection on an undeclared key; new tests for each `duplicatePolicy` value; new tests for keyed-lookup `removeFromModuleState`.
- `tests/config-server/integration/mcp-handshake.test.ts` — id-5 / id-6 `tools/call` arguments gain `key`; a new id-N call exercises the `UnknownStateKey` rejection over JSON-RPC.
- `tests/config-server/integration/docker-paired-fixture.test.ts` — `setModuleState` / `getModuleState` calls gain the `'port-registry'` key.
- `tests/modules/docker/PortRegistry.test.ts` — internal calls to the underlying API gain the `'port-registry'` key. The PortRegistry public-surface assertions are unchanged.

### Migration from on-disk state

Module state lives in zone 2 (`.gan-state/`), which is gitignored and per-machine. Pre-existing `.gan-state/modules/<name>/state.json` files become orphaned — never read, never written, but not actively cleaned up by the framework. Consequences:

- A user with existing `.gan-state/modules/docker/state.json` from before M3 will see PortRegistry rebuild its state on next `/gan` run (the new code reads `port-registry.json`, finds no file, starts fresh).
- The orphan file is harmless. Manual cleanup is fine but not required.
- This is acceptable because zone 2 is per-machine ephemeral state; the framework is pre-1.0 and explicitly does not support migration tooling.

A short note in the M2 README's troubleshooting section is worth adding ("if you see stale `state.json` after upgrading to M3, it's safe to delete") but no automated migration ships.

## Acceptance criteria

- The Configuration API surface (`getModuleState`, `setModuleState`, `appendToModuleState`, `removeFromModuleState`) accepts and validates a `key: string` parameter on every call.
- Each declared `stateKeys` entry persists to its own file at `.gan-state/modules/<name>/<key>.json`. Two declared keys in one module persist to two distinct files; neither overwrites the other.
- A `setModuleState` call against an undeclared `key` rejects with `ConfigServerError` whose `code === "UnknownStateKey"` and whose message names both the module and the key.
- `appendToModuleState` honours `duplicatePolicy`:
  - `"error"` (default) returns `{mutated: false, reason: 'duplicate-entry'}` on duplicate.
  - `"skip"` returns `{mutated: false, reason: 'duplicate-entry'}` on duplicate.
  - `"allow"` appends unconditionally.
- `removeFromModuleState` removes by `entryKey` (string) for both map-shaped and list-shaped (`{key: …}`-style) state values; non-existent `entryKey` is a no-op.
- The docker module's `PortRegistry` utility uses `setModuleState('docker', 'port-registry', …)` and reads via `getModuleState('docker', 'port-registry')`. Its public surface is unchanged.
- All module-state tests added in #6 are updated to pass the `key` parameter; new tests cover `UnknownStateKey`, each `duplicatePolicy` value, and keyed-lookup removal.
- `npx vitest run` passes; `npx tsc --noEmit` is clean.
- The post-M revision break is now closed: spec revisions plus this implementation alignment are both landed.

## Dependencies

- F2 (the per-key module-state contract this aligns to)
- M1 (modules architecture: `stateKeys` allowlist semantics, lifecycle, zone-2 ownership)
- M2 (the docker module whose `PortRegistry` ships under the realigned API)
- C4 (the project-tier-only rule for module configs — already aligned; no code change needed for that decision, but referenced because it's part of the same audit)

## Bite-size note

Sprintable as four steps that can land in one or split into two PRs (alignment vs. tests):

1. Storage layout + API signatures (`writes.ts`, `reads.ts`, `module-state-loader.ts`) — pure refactor with `stateKeys` allowlist enforcement bolted on.
2. `duplicatePolicy` parameter on `appendToModuleState` (mirrors `appendToOverlayField`'s implementation).
3. `removeFromModuleState` keyed lookup (replace deep-equal match with `entryKey` switch on shape).
4. PortRegistry update + test rewrites.

Step 1 is the largest. Steps 2–4 are smaller and could land in any order after Step 1.
