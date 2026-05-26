# O3 — Telemetry semantics

## Problem

[O2](O2-recovery.md)'s run-directory layout includes a `telemetry/` subdirectory and references `--no-telemetry`, but no spec defines what telemetry collects, where it goes, or what privacy posture it commits to. The result is an existing-but-unspecified surface: a directory and a runtime flag that ship in v1.0 with no spec authority pinning their behavior.

Three concrete consequences of leaving this unspecified:

- **No defensible privacy posture for v1.0 release.** A user asking "does ClaudeAgents send anything off my machine?" cannot point at a spec answering yes / no / under what conditions. The implementation is local-only today; the contract is in nobody's repo.
- **Schema drift risk at v1.0 freeze.** Without a pinned shape for the artifacts, two contributors writing against `telemetry/config.json` and `telemetry/outcome.json` could produce divergent files, and the divergence wouldn't show up until consumers (T2 cost surface in v1.1, V/B benchmark integrations in v2.0) tried to read them.
- **`--no-telemetry` semantics undefined.** Does it skip writing the directory entirely? Empty the directory? Write hashed-only files? The flag exists; the contract doesn't.

O3 closes the gap with a minimal v1.0 contract: two artifacts under `telemetry/`, a local-only invariant, a clean `--no-telemetry` semantics, and pinned schemas. The work is small (one spec, two schemas, modest implementation) but the gap is load-bearing for v1.0's privacy story.

O3 is the third spec under the **O** (observability and operations) phase code, after [O1](O1-resolution-observability.md) and [O2](O2-recovery.md). Where O1 surfaces resolution observability at run start (the startup log) and O2 owns the run-state lifecycle, O3 owns the run-summary artifacts an operator reads *after* the run terminates.

> **Status markers (per [D1](D1-diagnostic-clarity.md)).** O3's `--no-telemetry` flag is operative in v1.0 — its SKILL.md flag-parsing section carries `[shipped-in-v1.0]`, so D1's `lint-status-markers` (every SKILL.md section heading must carry a marker) passes for O3's addition once it lands. No part of O3 is deferred.

## Proposed change

### The `telemetry/` subdirectory

Every `/gan` run that does not have `--no-telemetry` set produces two files under the run's `telemetry/` subdirectory (`<store-root>/<repo-key>/runs/<run-id>/telemetry/` per [F7](F7-central-run-data-store-and-worktree-execution.md); formerly `.gan-state/runs/<run-id>/telemetry/`):

| File | Written when | What it captures |
|---|---|---|
| `config.json` | At run start, before the first agent spawns | The resolved-config snapshot from `getResolvedConfig()` — active stacks, overlay values, modules, additionalContext sources. |
| `outcome.json` | At run termination (graceful, halted, aborted, or errored) | Sprint dispositions, summary stats, terminalReason, aggregate cost rollups derived from the trace. |

The directory and both files live alongside the rest of the run directory in the central run-data store (per [F7](F7-central-run-data-store-and-worktree-execution.md); after F7 and its paired F8, F1's project-local zone 2 holds only a gan-created run-scoped worktree — run data and module state both move to their own central stores). They are never written to config (`.claude/gan/`) or cache (`.gan-cache/`). They share lifetime with the run directory: when the run is archived per O2, the telemetry files travel with it; when the run directory is cleaned, they go with it. The local-only / no-egress invariant below is unchanged by the relocation — the central store is on the same machine.

### `config.json` — resolved-config snapshot

The artifact is a `getResolvedConfig()` snapshot serialized to JSON exactly once at run start. Capturing at run start (rather than continuously) is deliberate: it answers the audit question "what was the framework's view of the project when this run began?" without re-running validation post-hoc.

Schema at `schemas/telemetry-config-v1.json`. The shape mirrors `getResolvedConfig()`'s response per [F2](F2-config-api-contract.md), with the addition of a `capturedAt` timestamp envelope:

```json
{
  "envelope": {
    "schemaVersion": 1,
    "capturedAt": "2026-05-08T14:18:02.001Z",
    "runId": "20260508T141801-a3f2"
  },
  "resolvedConfig": {
    "apiVersion": "0.1.0",
    "schemaVersions": { "overlay": 1, "stack": 1 },
    "runtimeMode": { "noProjectCommands": false },
    "stacks": { "active": [...], "byName": {...} },
    "overlay": {...},
    "additionalContext": {...},
    "modules": {...}
  }
}
```

The captured `resolvedConfig` is **frozen across user-side edits** for the run, consistent with the orchestrator's snapshot-freshness rule (per the `/gan` skill spec). A snapshot re-capture mid-run (triggered by a `mutated: true` API call) does NOT update `config.json` — `config.json` records the run-start view, not subsequent mutations. Mutations are reconstructable from the [T1](T1-structured-run-trace.md) trace.

### `outcome.json` — sprint disposition + summary stats

The artifact is written exactly once at run termination, regardless of how the run ended. It carries:

| Section | Purpose |
|---|---|
| `disposition` | Top-level run outcome: `"success"` \| `"rejected"` \| `"halted"` \| `"aborted"` \| `"errored"`. **`rejected`** = the gate refused the work; it maps from O2's `failed-evaluation-rejected` `terminalReason` (E8's renegotiation-cap rejection) — the most important new terminal state in v1.0. Without it a gate rejection would mis-bucket as `halted` (a safety halt) or `aborted` (user-initiated). |
| `terminalReason` | Per [O2](O2-recovery.md)'s `terminalReason` codes (kebab-case ASCII). |
| `sprints[]` | One entry per sprint that started: `{sprintNumber, status, attemptCounts: {<role>: <int>}, ...}`. |
| `cost` | Aggregate from [T1](T1-structured-run-trace.md) trace events: `{tokensInput, tokensCached, tokensOutput, llmCallCount, toolCallCount, wallClockMs}`. |
| `safetyHalts[]` | Summary references to safety halts (per [A1](A1-loop-and-thrash-detection.md), future [A2](A2-generator-scope-enforcement.md)) — `{sprintNumber, safetyClass, reason}`. The halt evidence lives in the trace; `outcome.json` carries summary references only. |
| `humanReviews[]` | When [E6](E6-pluggable-evaluator-role.md) ships in v1.2, summary references to human-evaluated sprints (`{sprintNumber, userIdentity, disposition}`). Reserved field in v1.0; empty array. |

**Complete `terminalReason` → `disposition` mapping.** O2 defines the `terminalReason` codes; O3 owns `disposition`. Every code maps to exactly one disposition — implementers must not guess:

| `terminalReason` (O2) | `disposition` (O3) |
|---|---|
| `complete` | `success` |
| `failed-evaluation-rejected` | `rejected` |
| `aborted-contract-failed` | `rejected` |
| `failed-max-attempts` | `halted` |
| `failed-budget` | `halted` |
| `failed-loop-detected` | `halted` |
| `aborted-by-user` | `aborted` |
| `failed-clarifier-error` | `errored` |
| `aborted-planner-error` | `errored` |
| `aborted-validation-failed` | `errored` |

Rationale and the naming caveat: `rejected` = the gate or contract refused the work (E8's post-generation gate rejection, and `aborted-contract-failed` = pre-generation negotiation that could not agree a contract — both are refusals, not crashes). `halted` = an A1 safety halt (ceiling / budget / loop). `aborted` = **user-initiated only** (`aborted-by-user`). `errored` = a component failed to run (clarifier/planner error, or `validateAll()` failing in aborting mode). Note the deliberate mismatch: most `aborted-*` `terminalReason` codes do **not** map to the `aborted` *disposition* — the `aborted-` prefix is historical, while `disposition` is semantic (user-initiated vs failure). A new O2 `terminalReason` code added later must add its row here in the same PR.

Schema at `schemas/telemetry-outcome-v1.json`. Example shape:

```json
{
  "envelope": {
    "schemaVersion": 1,
    "writtenAt": "2026-05-08T15:23:45.123Z",
    "runId": "20260508T141801-a3f2"
  },
  "disposition": "halted",
  "terminalReason": "failed-loop-detected",
  "sprints": [
    {
      "sprintNumber": 1,
      "status": "complete",
      "attemptCounts": { "gan-clarifier": 1, "gan-planner": 1, "gan-contract-proposer": 1, "gan-generator": 1, "gan-evaluator": 1 }
    },
    {
      "sprintNumber": 2,
      "status": "halted",
      "attemptCounts": { "gan-contract-proposer": 1, "gan-generator": 3, "gan-evaluator": 3 }
    }
  ],
  "cost": {
    "tokensInput": 38192,
    "tokensCached": 28412,
    "tokensOutput": 5347,
    "llmCallCount": 47,
    "toolCallCount": 8,
    "wallClockMs": 263000
  },
  "safetyHalts": [
    { "sprintNumber": 2, "safetyClass": "loopDetected", "reason": "editOscillation" }
  ],
  "humanReviews": []
}
```

The aggregate stats are *derived* from the T1 trace, not independently measured. A reader who needs per-LLM-call detail consults the trace; `outcome.json` is the summary view.

### Local-only invariant

**No telemetry data is transmitted off-machine by the framework.** This is a hard invariant for v1.0:

- `config.json` and `outcome.json` are written to local disk only.
- The framework does not read them after the run terminates (other than for `--recover` per O2).
- No HTTP / network / IPC egress carries telemetry payloads.
- `gan stats` and similar v1.1+ surfaces aggregate locally; they do not phone home.

Users running in air-gapped environments, regulated industries, or simply with a privacy preference get a defensible answer: nothing leaves the machine.

A future spec (placeholder **T-series — opt-in remote benchmarking**, post-v2.0) may govern any opt-in upload path. O3 is silent on it because no upload mechanism exists yet; speculating on the contract now would be premature.

### `--no-telemetry` runtime flag

Setting `--no-telemetry` on a `/gan` invocation **skips writing the `telemetry/` subdirectory entirely**:

- `telemetry/` is not created.
- Neither `config.json` nor `outcome.json` is written.
- The trace (`trace/` per T1) and per-sprint artifacts (contracts, feedback, etc.) are unaffected — `--no-telemetry` is specifically about the summary artifacts O3 owns, not about T1's event log.
- Recovery (per O2) treats a missing `telemetry/` as legitimate; a recovered run that originally ran with `--no-telemetry` does not retroactively gain telemetry files.

The flag is added to [runtime-knobs.md](runtime-knobs.md) in the same PR that lands O3's implementation. Default is **off** (telemetry is captured) — the chore was about pinning the contract, not about reversing the default.

### Atomicity and lifecycle

- **Atomic writes.** Both `config.json` and `outcome.json` are written via temp-file + rename. A SIGKILL between temp-write and rename leaves no partial file.
- **`config.json` is write-once.** Set at run start; never modified. A re-snapshot triggered by `mutated: true` does not update it.
- **`outcome.json` is write-once at termination.** A run that crashes before reaching termination leaves `outcome.json` unwritten; recovery via O2's `--recover` writes it on the resumed termination, derived from the (now-extended) trace.
- **No size cap, no rotation.** v1.0 ships no automatic cleanup; users running many sprints accumulate telemetry data alongside the rest of the run directory. Manual cleanup via the same path as `gan run prune` (T2, v1.1).

### Relationship to T1 trace data

T1 owns the **event log** (`trace/`); O3 owns the **summary artifacts** (`telemetry/`). The two are sibling concerns under the same run directory:

- T1 records every LLM call, tool call, agent attempt, safety halt, trust event, validation abort, milestone — appending events as the run progresses.
- O3 records the run-start configuration view (once) and the run-end summary (once).

`outcome.json`'s `cost` section is derived from T1 trace events at termination time **via R7's `aggregateRunSummary`** — the structured per-run aggregate (the markdown orchestrator does not hand-sum the events). If the trace is unavailable (corrupted, absent), `outcome.json` records `cost: null` rather than failing the run — the summary degrades gracefully. **If the trace is present but *detectably lossy*** — **R7's `reconcileTraceIndex` reports** that `index.json` does not reconcile to the `events/` file count, i.e. a best-effort emit was dropped (disk-full/EPERM per R7's emit-failure contract) — `cost` is marked incomplete (`cost.complete: false`, or null when the gap is unbounded) rather than reported as a confident-but-wrong total. A telemetry surface must not silently undercount: it reports either a verified-complete sum or an explicit incompleteness signal. The schema permits `cost` to be null and carries the `complete` flag.

`telemetry.tracePayloads` (T1's overlay splice point) controls *trace* payload content — it does not affect O3's artifacts. A run with `tracePayloads: "hashed"` and telemetry on still produces full `config.json` and `outcome.json` (these don't carry user-prompt content; they're configuration and aggregate metrics).

### What O3 does not do

- Specify schemas for any artifact other than `config.json` and `outcome.json`. The contract is bounded.
- Provide a CLI to read or summarise telemetry. That is T2's territory in v1.1 (`gan run report`, `gan stats`).
- Define an upload or transmission path. The local-only invariant is the v1.0 commitment; transmission specs are post-v2.0 if they ever land.
- Enforce telemetry capture. `--no-telemetry` is honoured unconditionally; users opting out are not nagged.
- Define a per-project default for telemetry on/off. v1.0 ships with telemetry on by default and `--no-telemetry` as the per-run opt-out. An overlay splice point (`telemetry.disabled`) is a v1.1+ candidate if usage shows projects want a persistent default; not promised here.

## Schema authority

O3 introduces two new schema documents per F3 conventions, both pinned at v1.0 freeze:

| Schema | Purpose |
|---|---|
| `schemas/telemetry-config-v1.json` | Validates `config.json` shape: envelope + resolved-config snapshot. |
| `schemas/telemetry-outcome-v1.json` | Validates `outcome.json` shape: envelope + disposition + sprints + cost + safetyHalts + humanReviews. |

Additive changes after v1.0 follow the project's "additive stays on `vN`" rule per [F3](F3-schema-authority.md): new optional fields, new enum values within an existing discriminator (e.g. new `disposition` values), new top-level sections (e.g. when E6 v1.2 lights up `humanReviews`). Field-rename or semantic-change forces `vN+1`.

Readers MUST tolerate unknown fields and unknown enum values per the same forward-compat invariant T1 documents — a reader implementing only v1 knowledge skips unknown fields with a structured warning, not erroring.

## Field encodings

Standard per A1 / T1 / E5 / E6 conventions:

- **Field names:** camelCase ASCII.
- **Enum string values** (`disposition`, status codes): camelCase ASCII for new fields; `terminalReason` follows O2's existing kebab-case convention (e.g. `failed-loop-detected`).
- **Run IDs:** `<YYYYMMDDTHHMMSS>-<4 hex>` per O2.
- **Timestamps:** RFC 3339 UTC with millisecond precision.
- **Token counts and millisecond durations:** non-negative integers.

## Acceptance criteria

### Automated checks

- A completed `/gan` run produces both `<store-root>/<repo-key>/runs/<run-id>/telemetry/config.json` and `.../outcome.json` (central store, per F7).
- `config.json` validates against `schemas/telemetry-config-v1.json`.
- `outcome.json` validates against `schemas/telemetry-outcome-v1.json`.
- A `/gan --no-telemetry` invocation produces no `telemetry/` subdirectory at any point during or after the run.
- A run halted by [A1](A1-loop-and-thrash-detection.md) writes `outcome.json` with `disposition: "halted"`, the matching `terminalReason`, and a non-empty `safetyHalts[]` summary.
- The `cost` aggregate in `outcome.json` matches the sum of token / call counts in the T1 trace for the same run.
- A SIGKILL between `outcome.json` temp-write and rename leaves either the complete file or no file (atomicity).
- Recovery via [O2](O2-recovery.md)'s `--recover` flow on a previously-interrupted run writes `outcome.json` at the resumed termination; `config.json` from the original run is preserved unmodified.
- Trace files (`trace/`) are unaffected by `--no-telemetry` — only the `telemetry/` subdirectory is gated.

### Manual review checks

- The local-only invariant is documented in the v1.0 release notes prominently enough that a user concerned about privacy can verify it without reading the spec.
- The `--no-telemetry` flag is named in `gan --help` output (per [R3](R3-cli-wrapper.md)).
- A reviewer can answer "what does ClaudeAgents capture and where does it go?" by pointing at this spec.

## Examples

A `config.json` for a Node web project run:

```json
{
  "envelope": {
    "schemaVersion": 1,
    "capturedAt": "2026-05-08T14:18:02.001Z",
    "runId": "20260508T141801-a3f2"
  },
  "resolvedConfig": {
    "apiVersion": "0.1.0",
    "schemaVersions": { "overlay": 1, "stack": 1 },
    "runtimeMode": { "noProjectCommands": false },
    "stacks": {
      "active": ["web-node"],
      "byName": {
        "web-node": { "tier": "builtin", "schemaVersion": 1, "path": "/Users/taa/.../stacks/web-node.md" }
      }
    },
    "overlay": {},
    "additionalContext": { "planner": [], "proposer": [] },
    "modules": {
      "docker": { "name": "docker", "pairsWith": "docker", "manifestPath": "..." }
    }
  }
}
```

An `outcome.json` for a successful one-sprint run:

```json
{
  "envelope": {
    "schemaVersion": 1,
    "writtenAt": "2026-05-08T14:23:45.123Z",
    "runId": "20260508T141801-a3f2"
  },
  "disposition": "success",
  "terminalReason": "complete",
  "sprints": [
    {
      "sprintNumber": 1,
      "status": "complete",
      "attemptCounts": {
        "gan-clarifier": 1,
        "gan-planner": 1,
        "gan-contract-proposer": 1,
        "gan-generator": 1,
        "gan-evaluator": 1
      }
    }
  ],
  "cost": {
    "tokensInput": 38192,
    "tokensCached": 28412,
    "tokensOutput": 5347,
    "llmCallCount": 8,
    "toolCallCount": 12,
    "wallClockMs": 263000
  },
  "safetyHalts": [],
  "humanReviews": []
}
```

## Dependencies

- **F1** — zone semantics; `telemetry/` is zone 2.
- **F2** — `getResolvedConfig()` is the source for `config.json`'s `resolvedConfig` field.
- **F3** — schema authority for the two new schema documents; immutable-once-published rule applies.
- **O2** — owns the run-directory layout (`telemetry/` is part of it); `terminalReason` codes used in `outcome.json` are defined here; recovery interaction.
- **T1** — `cost` aggregate is derived from T1 trace events; `safetyHalts[]` summary references T1's `safetyHalt` events.
- **E1** — orchestrator writes `config.json` at run start and `outcome.json` at run termination.
- **R3** — the `--no-telemetry` runtime flag is added to the CLI's flag table; `runtime-knobs.md` updated in the same PR.
- **A1** — `safetyHalts[]` summary references A1's `loopDetected` halts.
- **E6** *(v1.2)* — `humanReviews[]` is reserved at v1.0 and lit up when E6 ships.

## Bite-size note

Sprintable as:

1. (one sprint) Schema authoring (`telemetry-config-v1.json` and `telemetry-outcome-v1.json`) and the corresponding TypeScript types.
2. (one sprint) Orchestrator emission of `config.json` at run start (read from `getResolvedConfig()`, write atomically).
3. (one sprint) Orchestrator emission of `outcome.json` at run termination (aggregate from T1 trace, write atomically). Includes the SIGKILL-tolerant rename path.
4. (rides with R3 maintenance) `--no-telemetry` flag parsing + runtime-knobs.md update + `gan --help` text.
5. (one sprint) Test coverage: schema validation, atomicity, `--no-telemetry` gate, recovery interaction, cost-aggregate matches trace.

Slices 1–3 must land in order; slice 4 lands alongside slice 1's flag parsing; slice 5 depends on 1–4.
