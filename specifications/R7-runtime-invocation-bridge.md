# R7 — Runtime invocation bridge

## Problem

The orchestrator and agents are **markdown executed by Claude**, not a program. They can call only what is exposed as an MCP tool or a `gan` CLI subcommand. Today exactly one surface is exposed that way: the Configuration API (R1's MCP server). Every other framework library is reachable only by `import` — which a markdown orchestrator cannot do.

The consequence is that four shipped, fully-tested libraries are **uncallable from the only orchestrator that exists**:

- **`src/trace/` (T1)** — the orchestrator is told to "emit a typed event at each milestone, agent attempt, LLM call, and tool call" and to drive the stderr heartbeat/summary formatters. It has no tool to do so. Real runs under the central store contain **zero** trace events.
- **`src/safety/` (A1)** — the per-role ceiling, sprint budget, and edit-oscillation checks are pure functions the orchestrator is told to call at every attempt boundary. There is no tool. No loop-detection halt can fire, because the check is never invoked and the `agentAttempt` events it reconstructs from do not exist.
- **`src/agents/evaluator-core/` (E3)** — the evaluator agent is told to "consume the evaluator plan" and "delegate every deterministic decision to evaluator-core." There is no tool that returns the plan; the agent reasons in its place.
- **`src/modules/docker/` (M2)** — agents are meant to "reuse one battle-tested implementation rather than reinventing the helpers per project." No agent prompt references it, and there is no tool; a containerized run hand-rolls Docker via Bash, the exact duplication M2 exists to prevent.

The architectural rule that closes this gap already exists for the config server: the **dual-callable surface rule** (R1-locked) — *every public API function is callable both via an MCP tool wrapper and via direct library import, same underlying function, never two implementations.* R7 generalises that rule from the Configuration API to the trace, safety, evaluator-core, and module libraries. Where a library exposes only an in-memory or stateful entry point (the trace emitter is a stateful class; some formatters take in-memory arrays), R7 adds a **single** thin disk-backed function that both the tool and any library caller share — preserving "never two implementations." It introduces no new *domain* logic; it makes already-shipped logic reachable from a markdown orchestrator.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — it extends the existing framework MCP server and the R1-locked dual-callable pattern; it reaches around nothing.
2. **Composable by other agents/specs?** Yes — every downstream spec that assumes trace data exists (O2 recovery, O3 telemetry, T2 read CLIs, T3 budgets, E8) builds on the surface R7 exposes, without re-implementing it.
3. **Owns/accesses durable structured state?** Yes — it is the call path to zone-2 trace artifacts, the module-state store, and the deterministic evaluator plan.
4. **Fits existing ownership lanes?** Yes — same MCP server, same central-store and module-state write channels (F7/F8), same schema set; no new zone, no new ownership lane.
5. **Stackable / non-terminal?** Yes — it is pure infrastructure; its first invocation is the start of its usefulness, not the end.

Passes all five: this is infrastructure, and it is the keystone the v1.0 trust story depends on.

## Proposed change

Extend the **existing** framework MCP server (R1's `claudeagents-config` server) with four new tool groups, dispatched through the same table the config tools use. No second MCP server; no change to `install.sh`'s registration. Each tool wraps the same underlying function the library exposes (per the dual-callable rule), with the additions and exceptions called out below.

### Single server vs. a sibling (justification)

The new tools live in the existing server, not a sibling, because: one registration keeps `install.sh` and the restart-once contract unchanged; one dispatch table and one per-run log/trust context avoid duplicating R1's machinery; and the orchestrator already holds exactly one MCP connection. The server's name (`claudeagents-config`) is historical; its remit is "the framework's runtime API." The one risk a single server creates — a module that fails to load taking the whole server down — is eliminated by the lazy-load rule below.

### Tool groups

Argument and return shapes are the **existing** shapes except where noted; "Schema additions" lists the catalog growth. Run-scoped tools take an explicit run directory argument (the central-store run dir resolved per F7), mirroring how config tools take an explicit `projectRoot` — explicit arguments keep the tools deterministic and unit-testable.

- **Trace (`src/trace/`)**
  - `emitTraceEvent({ runDir, event })` → appends one typed event and returns its `sequenceNumber`. **Stateless per call:** rather than wrapping the stateful `TraceEmitter` class, the tool calls a new shared function `appendTraceEvent(runDir, event)` that reads the current highest sequence from the run's trace index, assigns the next number, and writes the event file with **exclusive-create (`O_EXCL` / `wx`) on the `events/<seq>.json` path** — so a sequence collision *fails the write rather than silently overwriting it*; on `EEXIST` the function re-reads the highest sequence and retries (bounded); **if the bounded retry is exhausted it surfaces a structured warning (handled like the `agentAttempt`-emit failure below), never a silent drop.** This honours the established "the trace is the only counter" principle (the same source of truth recovery and the safety checks read), so no in-memory emitter state is required and there is one implementation behind both the tool and any library caller. The orchestrator is the intended **sole** trace writer for a run (as it is the sole writer of `progress.json` per SKILL.md), so collisions are not expected in normal operation — but the exclusive-create+retry is the defence-in-depth that prevents silent event loss if the markdown orchestrator ever fires a parallel tool call. (Plain temp-write+rename is unsafe here precisely because rename *overwrites*: two appends that read the same highest sequence would both target `events/N.json` and the second would clobber the first with no error.) **The per-run `index.json` is a *derived* artifact — a cache of counts/offsets over `events/`, not a second source of truth.** `events/` is authoritative; any reader or `--recover` reconciles the index from `events/` (via `reconstructRecoveryState`). The shared index write therefore stays a plain overwrite, and a lost index update under concurrent append is **self-healing** (it can undercount transiently but is rebuilt from the authoritative event files) — the "loses no event" guarantee rests on the exclusive-created event files, never on the index write.
  - `runSprintSummary({ runDir })` and `formatHeartbeat({ role })` / `formatLlmCallSummary({ metrics })` → the stderr formatters (metadata only, never payload content). `formatHeartbeat`/`formatLlmCallSummary` wrap the existing in-memory formatters directly. `runSprintSummary` is a new shared disk-reading wrapper over `formatSprintSummaryFromEvents(events)` (the shipped function takes an in-memory array; the tool needs to scan the run dir) — a thin single-implementation function both the tool and library expose.
  - `reconstructRecoveryState({ runDir })` → wraps `reconstructRecoveryState(traceRoot)` — the per-role attempt accounting and generator fingerprint history rebuilt purely from `agentAttempt` events (the read substrate O2 and the safety tools share).
- **Safety (`src/safety/`)** — all pure, all consume reconstructed state:
  - `checkRoleCeiling`, `checkSprintBudget`, `detectEditOscillation` → the three halt decisions, with the same positional/object signatures the library exposes (the implementing PR pins the exact argument shapes in the api-tools catalog).
  - `buildLoopDetectedBody`, `createLoopDetectedError`, `createSprintBudgetError`, `createEditOscillationError` → the `safetyHalt` body and `LoopDetected` error builders.
- **Evaluator-core (`src/agents/evaluator-core/`)**
  - `buildEvaluatorPlan({ snapshot, sprintPlan, worktreeState })` → wraps `buildEvaluatorPlan(snapshot, sprintPlan, worktreeState)`. Returns a **plan**: data describing which commands to run and which surfaces fired — not execution (see "Relationship to F4").
- **Modules (`src/modules/`)** — **lazy-loaded** (see below):
  - `dockerReservePort`, `dockerReleasePort`, `dockerDiscoverPort`, `dockerCheckContainerHealth`, `dockerContainerName` → the `PortRegistry` / `PortDiscovery` / `ContainerHealth` / `ContainerNaming` helpers; registry state persists through the module-state store (F8).

### Lazy module loading (must-fix — prevents a boot crash)

`src/modules/docker/index.ts` runs a prerequisite check (`docker --version`) **at import time** and throws `ModulePrerequisiteFailed` on a host without Docker. The config server wires its tools via top-of-file static imports; importing the docker tools the same way would execute that throw at server startup and take down **every** tool — `getResolvedConfig`, `validateAll`, all of it — on every Docker-less host (i.e. most hosts). Therefore the module tools MUST be loaded with a **dynamic `import()` inside the handler**, not a static top-level import. A host without Docker surfaces the manifest `errorHint` from the failed lazy import (error-text discipline) and the rest of the server is unaffected.

### Relationship to F4 (trust) and command execution

R7 widens the surface that *touches* commands, so its trust posture is explicit:

- **`buildEvaluatorPlan` returns data, never executes.** The plan lists command strings (audit/lint/test/build/doc-lint + `evaluator.additionalChecks`); execution stays the agent's job, under the PreToolUse confinement and the trust gate the orchestrator already passes. Per E1, the orchestrator runs `validateAll()` at run start, which surfaces `UntrustedOverlay` *before* any command-bearing path; the plan's commands therefore derive from already-validated config. The tool itself runs no command.
- **The docker exec tools run real processes**, so they honour the run's resolved trust posture: they are callable only within a run whose `validateAll()` trust check has passed; `--no-project-commands` suppresses project-sourced command behaviour for the run; and `GAN_TRUST=strict` fails closed in CI exactly as it does for the config path (F4/F6).
- R7 adds **no** new bypass of the trust ladder: data-returning tools cannot execute, and exec-capable tools inherit the existing gate.

### Emit-failure semantics

Trace emission is **best-effort and never aborts a run**: a failed `emitTraceEvent` (disk-full, EPERM) is logged via the config server's logging channel and the run continues — a missing `llmCall`/`toolCall`/milestone event degrades observability, not correctness. The **one exception**: a failed `agentAttempt` emit corrupts the attempt accounting the safety checks and recovery read, so the tool retries once and, on persistent failure, returns a structured warning the orchestrator surfaces (the run may continue, but the user is told the safety counters for that attempt are unreliable). An AC pins both behaviours.

### Confinement (unchanged)

Per E1/H1, MCP tool calls are not file-system reads and do not break the PreToolUse confinement; confined agents may call the new tools freely. The tools' own writes land in zones the hook already allows: trace events go to the F7 central-store run dir (allowed via the orchestrator-exported `GAN_RUN_DIR`), and registry state goes through the config server's module-state channel (F8). No new confinement grant is required.

### Performance

Emission is a single append: `appendTraceEvent` reads the index tail for the current sequence (O(1)), not a full event rescan, so per-call cost is one stat + one append + one index update — acceptable for the per-LLM-call/per-tool-call cadence. The implementing PR must avoid an O(n²) "reconstruct from all events on every emit" pattern.

### What R7 does not do

- It does not add a `gan run report` read CLI — that is T2 (v1.1). v1.0 users read trace files directly, per T1.
- It does not change any library's domain logic, thresholds, or data schemas.
- It does not decide *when* the orchestrator calls a tool — timing stays SKILL.md's responsibility (A1/T1/E8 prescribe it).
- It does not introduce a programmatic orchestrator; the orchestrator stays the `/gan` skill, now able to call the tools where SKILL.md names library helpers. D1 (status markers) flips the affected SKILL.md sections from aspirational to operative once R7 lands.

## Schema and surface additions

- **`schemas/api-tools-v1.json` grows** with one tool-input-schema entry per new tool, following the config server's existing precedent for tool additions (the implementing PR applies F3's schema-versioning rule as R1 already applies it to this catalog). The "no schema additions" claim of an earlier draft was wrong; this is the catalog growth.
- **New shared library functions** (single-implementation, exposed to both tool and library import): `appendTraceEvent(runDir, event)` and `runSprintSummary(runDir)` in `src/trace/`. These are thin disk-backed wrappers, not new domain logic.
- **No new data-shape schema.** Every tool serialises an existing shape: `run-trace-v1` (trace tools, including the `safetyHalt` body and `LoopDetected` error A1 already reserved), the evaluator plan type (E3), and `module-config-docker-v1` / module-state shapes (M2/F8).
- Any `gan` CLI mirror introduced for scripting (e.g. `gan run emit` for non-orchestrator callers) is a user-facing subcommand and lands in [`runtime-knobs.md`](runtime-knobs.md) in the implementing PR. The MCP tools themselves are an agent-facing surface (the tool catalog), not a user-facing runtime knob.

## Acceptance criteria

### Automated checks

- **Server boots without Docker.** With no `docker` binary on `PATH`, the MCP server starts and every config tool (`getResolvedConfig`, `validateAll`, …) responds; only the docker tools surface the manifest `errorHint` when invoked. (Guards the lazy-load rule.)
- **Trace is non-empty (tool-level, CI-runnable).** A harness that calls `emitTraceEvent` once per *simulated* agent attempt — **no LLM, no real `/gan` run** — produces a non-empty `trace/events/` with gapless sequence numbers and an index that resolves every event. This is the CI-testable form; CI has no LLM, so it cannot drive the markdown orchestrator. The end-to-end "a real orchestrated run actually emits a trace" assertion needs an LLM and is therefore **dogfood/manual-only** (tracked as a program risk in the roadmap, not a CI gate) — R7 proves the *tool* works and is *called* at the documented SKILL.md points, not that Claude obeys every emit instruction at runtime.
- **Concurrent append loses no event.** Two appends racing on the same run produce two distinct events (exclusive-create + retry), never a clobber; the event *count* equals the number of appends and the sequence is gapless — a gapless-but-lossy log (count < appends) fails this check. **And after the racing appends, `index.json` is verified *reconcilable* from `events/`: a reconcile pass makes `totalEvents` equal the event-file count** (the index is a derived cache, so a transient undercount is acceptable only if it rebuilds exactly from the authoritative events). Guards both the event-file race and the index lost-update.
- **Tool-vs-library parity.** For every new tool, a test asserts the tool handler and the direct library import call one underlying function (no second implementation) — including the new shared `appendTraceEvent` / `runSprintSummary` functions.
- **Safety tools agree with the library** on a constructed attempt history (post-rejection guard and 3-cycle cases included).
- **Evaluator plan byte-identical** via tool vs library on the E3 pipeline fixtures.
- **Module state round-trips** and a duplicate reservation surfaces the existing `PortInUse` error.
- **Emit failure does not abort; `agentAttempt` failure warns.** Injected write failure on a non-`agentAttempt` event continues the run silently-logged; on an `agentAttempt` event it returns the structured warning.
- **No untrusted-command bypass.** `buildEvaluatorPlan` executes nothing (returns data only); a docker exec tool invoked under `GAN_TRUST=strict` without a passed trust check fails closed.

### Manual review checks

- SKILL.md's trace, safety-halt, and evaluator-plan integration points resolve to named R7 tools (cross-checked against D1's status markers in the same release).
- No new MCP server is registered; `install.sh` is unchanged.

### Deferred-by-design

- **A live loop-detection halt firing end-to-end** is verified when E8 and v1.0 dogfooding land (E8 drives the attempts that reach a ceiling); R7 verifies only that the check is callable and correct.
- **A rich read surface over the now-real trace** is deferred to T2 (v1.1), per T1's data-first / read-second split.

## Dependencies

- **T1, A1, E3, M2** — the libraries R7 exposes. Shipped; cross-referenced, not edited.
- **R1** — the MCP server and the dual-callable-surface rule R7 generalises. Shipped; not edited.
- **F4/F6** — the trust ladder the command-bearing/exec tools honour. Shipped; not edited.
- **F7, F8** — the central run-data store and module-state store the trace and module tools write through.

## Bite-size note

One coordinated PR, sliced per tool group so each lands behind a parity test:

1. Trace tools (`appendTraceEvent` + `emitTraceEvent` + formatters + `reconstructRecoveryState`) — unblocks O2/O3 and the trace-non-empty AC. Highest leverage; lands first.
2. Safety tools — unblocks A1's halts becoming reachable.
3. Evaluator-core tool (`buildEvaluatorPlan`) — unblocks E8's forced-plan consumption.
4. Module tools (docker, lazy-loaded) — unblocks the Docker wiring slot; the boot-without-Docker AC gates this slice.

~3–4 sprints. Slice 1 is highest-leverage; the rest parallelise.
