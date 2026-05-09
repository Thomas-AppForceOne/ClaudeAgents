# T1 — Structured run trace

## Problem

The path between user prompt and final result is currently opaque. The orchestrator invokes agents, agents call LLMs, LLMs use tools, the evaluator scores, and at the end the user sees a verdict — but the chain in between is not captured anywhere. This blocks several things v1.0 cannot ship without:

- **Debuggability.** When a user reports "the generator did the wrong thing," there is no record of what prompt the generator actually saw, what response it produced, or which tool calls it made.
- **Loop detection (A1) needs an attempt-by-attempt history.** Without a trace, A1 has no source of truth for "how many attempts have happened" beyond an in-memory counter that does not survive recovery.
- **Recovery (O2) needs a replayable record of work-in-progress.** O2's archive stores artifacts; T1 stores the *sequence* that produced them.
- **Cost accounting (T2 in v1.1) reads from the trace.** Without T1, T2 has nothing to aggregate.
- **Verdict accuracy (V1 in v2.0) compares evaluator outputs against expected outputs across runs.** The trace is the per-run record V1 reads.

T1 introduces a structured, append-only event log per run. It is the substrate that A1, O2, T2, V1, and Q1 all read from. Landing it in v1.0 makes every later phase materially cheaper — they read trace events instead of inventing their own logging.

T1 is the first spec under the **T** (telemetry) phase code.

## Proposed change

### Location and lifetime

A run's trace lives at `.gan-state/runs/<run-id>/trace/`. Each event is one entry; the directory contains the events plus an index file (`index.json`) summarising counts and time bounds for fast read.

The trace's lifetime equals the run's lifetime under F1 zone semantics. When a run terminates (per O2's terminal-marker convention — the run state persists in place under `.gan-state/runs/<run-id>/`) the trace remains alongside the rest of the run's artifacts. When zone 2 is cleaned the trace goes with it. The trace is never written to zone 1 (config) or zone 3 (cache).

The trace is **append-only**. Once written, an event is never modified or deleted. Corrections happen via additional events that supersede earlier ones; historical accuracy is preserved.

### Event taxonomy

T1 defines seven event classes. Every event has a common envelope (timestamp, sequence number, event type, run-id) plus class-specific fields.

**1. `orchestratorMilestone`** — sprint-level transitions.

Captures: sprint start, sprint end (with disposition), role transitions (clarifier-start, planner-start, etc.), revision-break entries.

Fields: `milestone` (enum), `disposition` (for end events: `success` | `halted` | `aborted` | `error`), `summary` (short prose).

**2. `agentAttempt`** — one per agent invocation.

Captures: which role attempted, which attempt number it is for that role, what input it was given (snapshot reference + prompt), what artifact it produced.

Fields: `role`, `attemptNumber`, `inputDigest` (hash of the inputs fed to the agent), `outputArtifactPath`, `disposition` (`completed` | `objected` | `failed`).

A1 reads `agentAttempt` events to drive ceilings.

**3. `llmCall`** — one per LLM API call.

Captures: model name, role of the calling agent, prompt content reference, response content reference, token counts (input/output/cached), latency, cache hit status.

Fields: `model`, `role`, `promptRef`, `responseRef`, `tokensInput`, `tokensCached`, `tokensOutput`, `latencyMs`, `cacheHit` (boolean).

The actual prompt and response content lives at the referenced paths under `.gan-state/runs/<run-id>/trace/payloads/`, not inline in the event. This keeps the event log scannable; T2 aggregations don't have to skim long content blobs.

**4. `toolCall`** — one per tool invocation by an agent.

Captures: tool name, agent role, arguments digest, result digest, success/failure, latency.

Fields: `tool`, `role`, `argumentsRef`, `resultRef`, `disposition`, `latencyMs`.

**5. `safetyHalt`** — A1 halts and future A2 scope-violation halts.

Captures: which safety mechanism triggered, which role was involved, the structured payload defined by the triggering spec.

Fields: `safetyClass` (discriminator: `loopDetected` | `scopeViolation` | future), `role`, `payload` (class-specific shape owned by the triggering spec).

A1 owns the `loopDetected` discriminator and its payload shape; A2 (v1.1) owns `scopeViolation`. T1 reserves the class and provides the extension point.

**6. `trustEvent`** — F4 trust-prompt outcomes.

Captures: which prompt fired, which branch the user picked.

Fields: `promptVariant` (`subsequentChange` | `initialIntroduction`), `userChoice` (`view` | `approve` | `runWithoutProjectCommands` | `cancel`), `contentHash`.

**7. `validationAbort`** — `validateAll()` failures that abort the run.

Captures: which validation failed, structured-error payload from F2.

Fields: `validationStage` (`config` | `overlay` | `stack` | `module`), `errorCode`, `errorPayload`.

The earlier draft of T1 used a single "safety events" class for halts, trust, and validation. Splitting into three top-level classes gives readers a typed contract: A1 listens to `safetyHalt`, F4 telemetry consumers listen to `trustEvent`, validation diagnostics read `validationAbort`.

### Schema authority

The trace event schema lives at `schemas/run-trace-v1.json` per F3 conventions. The schema defines the common envelope and a discriminated union over the seven event classes.

T1 ships **v1**. The post-v1.0 audit will examine fields surfaced by real debugging needs and determine whether to bump to `run-trace-v2`. Pre-v1.0 schema-version freedom applies until v1.0 ships; after that, **additive changes stay on v1**:

- New optional fields on an existing event class.
- New discriminator values within an existing event class (e.g. A2's future `scopeViolation` under `safetyHalt`).
- New event classes entirely (e.g. E5's `clarifierFinding`, added in E5's implementation PR).

Field-rename or semantic-change forces v2.

**Readers MUST tolerate unknown discriminator values within a known event class AND unknown event-class types** — this is the forward-compat invariant that lets later specs extend the trace without bumping the schema version. A reader implementing only v1 knowledge encounters an unfamiliar event class by skipping the event with a structured warning, not erroring.

The index file (`index.json`) is a separate schema, `schemas/run-trace-index-v1.json`, kept simple: total event count, count per class, first and last timestamp, run disposition (set when the run terminates).

### Hash boundary

`promptRef` and `inputDigest` are hashes; the boundary of what's hashed is load-bearing for T2's cache-hit accounting and V1's cross-run comparison. Definition:

- **In** the hash: system prompt, user prompt, full message history, tool definitions, model name.
- **Out** of the hash: temperature, top-p, top-k, seed, max-tokens, run-id, timestamps, any field that varies between runs without changing the request's logical identity.

Rationale: the hash identifies "same logical request to the model" so cache-eligibility comparisons are honest. Anthropic's prompt cache is prefix-based — the boundary aligns with what the upstream cache treats as identical, so cache-hit attribution in T2 is accurate.

### Field-level contracts

Three contracts apply to every event:

- **Timestamps are RFC 3339 UTC with millisecond precision.** Local timezones are forbidden — they make traces from different machines incomparable.
- **Sequence numbers are monotonic non-negative integers, no gaps.** A reader can sort events by sequence number and recover the order they were emitted.
- **Hashes are stable within the boundary defined above.** The same hashed inputs produce the same hash regardless of time, machine, or run.

### Payload storage

LLM-call prompts and responses, and tool-call arguments and results, are stored under `.gan-state/runs/<run-id>/trace/payloads/`:

- **Naming.** `<seq>-<role>-<class>.<ext>` where `<seq>` is the event's zero-padded sequence number (10 digits), `<role>` is the agent role, `<class>` is one of `prompt` | `response` | `arguments` | `result`, and `<ext>` matches the content type (`md` for text, `json` for structured).
- **Atomicity.** Each payload file is written via temp-file + rename within the trace directory. Partial-write artifacts under a temp prefix are cleaned on next run start.
- **References.** The corresponding `llmCall` or `toolCall` event carries the relative path from the trace root.

### Privacy and content sensitivity

LLM prompts and responses can contain code from the user's repo, including potentially secrets the agent saw before A4 (PII catalog) ships in v1.1. T1 ships with these defaults:

- **Default mode: full content.** Prompts and responses are stored verbatim under `payloads/`. This is the most useful mode for debugging and is the v1.0 default.
- **Configurable redaction via overlay.** A new splice point `telemetry.tracePayloads` accepts `"full"` (default) or `"hashed"` (only hashes are recorded; content is not stored).
- **No transmission off-machine.** The trace lives entirely under the user's `.gan-state/`. T1 does not ship trace data anywhere.

Hashes themselves are not sensitive: they identify content but cannot be reversed to retrieve it. The redaction mode trades human-readability of stored payloads for assurance that no repo content sits on disk under `.gan-state/`.

Users who switch to `hashed` mode after a sprint cannot recover the original payloads — the redaction is at write time. This is by design: keeping the option to reverse the redaction would defeat the point.

### Durability

Append-only is the contract; durability under crash is the implementation that makes it real. T1 specifies:

- **Atomic writes.** Each event file and each payload file is written via temp-file + rename. A SIGKILL between temp-write and rename leaves no partial event.
- **Index lag.** The index file is updated last and may lag the events. Readers MUST treat the events as authoritative when the index disagrees.
- **Reconciliation on startup.** When the orchestrator opens an existing run state (e.g. for `--recover`), it scans the events directory and reconciles the index against what's on disk. Missing index entries are added.
- **Unrecoverable criterion.** A run is unrecoverable when (a) any event file has a malformed envelope, OR (b) more than 1 event file is present without a readable sequence number. `--list-recoverable` filters out unrecoverable runs.

### Index regeneration

Every event file is self-describing — it carries its sequence number, type, and timestamps in its envelope. The index file is a derivative artifact; it can be reconstructed by scanning event files and sorting by sequence number.

Regeneration via a `gan run repair-trace` command is a deferred T2 feature; for v1.0, regenerability is a property of the format, not an exposed command. A user with a corrupted index can rebuild manually by reading the events directory.

### Storage and retention

v1.0 ships no automatic rotation, no size cap, and no automatic cleanup. Trace lifetime equals run-state lifetime under F1's zone-2 rules. Users running many sprints accumulate trace data; manual cleanup via `gan run prune` is deferred to T2.

v1.0 acceptance includes documenting the storage model (in user-facing release notes) so users know to monitor `.gan-state/` size if they run many sprints.

### Read surface for v1.0

T1 ships only the on-disk format and the schemas. There is no `gan run trace` CLI command in v1.0; users who need to read the trace open the files directly.

This split is intentional: shipping the data first, the read surface second, lets v1.0 dogfooding tell us what the read CLI should prioritise. Without trace data in real users' hands, the read CLI's design would be speculative. T2 (v1.1) adds the read CLI on top of the existing structure.

### Recovery integration

O2's archive includes the entire trace directory. `--recover` reads the trace to reconstruct sprint state — most importantly, A1's attempt counters and the position of the last completed milestone. A recovered sprint continues writing to the same trace directory; new events get sequence numbers continuing from where the archive ended.

If a run is unrecoverable per the criterion above, `--list-recoverable` filters it out.

### What T1 does not do

- Track cost in dollars (deferred to T2 in v1.1).
- Enforce budgets (deferred to T3 in v1.2; T1 is read-only from a budget perspective).
- Provide a query language or read CLI (deferred to T2).
- Stream events to external sinks (out of scope per the "local files only" principle for v1.0; external integrations post-v2.0).
- Record agent intermediate reasoning beyond what the LLM API exposes in the response payload (out of scope; T1 records what the API returned, nothing more).
- Provide automatic rotation, retention, or cleanup (deferred to T2).

## C3 amendments

T1 introduces one new overlay splice point. C3's splice-point catalog gains an entry for it in T1's implementation PR.

| Splice point | Type | Default | Tier scope |
|---|---|---|---|
| `telemetry.tracePayloads` | enum — `"full"` \| `"hashed"` | `"full"` | both tiers |

Follows C4's scalar cascade rule. The setting is read at `validateAll()` time and applied to every event the orchestrator and agents emit during the run.

## Field encodings

T1's event fields and schemas follow these encodings, common to v1.0 specs introducing new schema-bearing types and aligned with conventions established by F2 / F4 / U3:

- **Field names:** camelCase ASCII (e.g. `eventType`, `safetyClass`, `tokensInput`).
- **Error codes** (referenced in `validationAbort` payloads): PascalCase ASCII as Type-like names (e.g. `UntrustedOverlay`, `PathEscape`).
- **Event-class names and discriminator string values:** camelCase ASCII (e.g. `agentAttempt`, `llmCall`, `safetyHalt`, `loopDetected`).
- **Role IDs:** kebab-case ASCII (e.g. `gan-generator`).
- **Hashes:** SHA-256, hex-encoded lowercase, 64 chars.
- **Timestamps:** RFC 3339 UTC with millisecond precision.
- **Sequence numbers:** monotonic non-negative integers, no gaps; zero-padded to 10 digits in payload filenames.
- **Paths (in references):** relative POSIX from the trace root, no leading separator.

The PascalCase / camelCase distinction between error codes (e.g. `LoopDetected`) and trace-event discriminators (`loopDetected`) is intentional: F2's structured-error layer treats codes as types, T1's trace layer treats discriminators as enum values. Both naming styles refer to the same concept across different namespaces.

This convention is duplicated across A1, T1, and E5 for v1.0; an F3 update in v1.1 centralises it.

## Examples

An `agentAttempt` event:

```json
{
  "envelope": {
    "sequenceNumber": 17,
    "eventType": "agentAttempt",
    "timestamp": "2026-05-08T14:23:45.123Z",
    "runId": "20260508-142301-a3f2"
  },
  "role": "gan-generator",
  "attemptNumber": 2,
  "inputDigest": "a3f2c8b1d9e7f4a6c2b8d1e5f9a3c7b4e2d8f1a5c9b3e7d2f8a4c1b6e9d3f7a2",
  "outputArtifactPath": "artifacts/gan-generator/attempt-2/diff.patch",
  "disposition": "completed"
}
```

An `llmCall` event:

```json
{
  "envelope": {
    "sequenceNumber": 18,
    "eventType": "llmCall",
    "timestamp": "2026-05-08T14:23:45.456Z",
    "runId": "20260508-142301-a3f2"
  },
  "model": "claude-opus-4-7",
  "role": "gan-generator",
  "promptRef": "payloads/0000000018-gan-generator-prompt.md",
  "responseRef": "payloads/0000000018-gan-generator-response.md",
  "tokensInput": 4827,
  "tokensCached": 3201,
  "tokensOutput": 612,
  "latencyMs": 8341,
  "cacheHit": true
}
```

A `safetyHalt` event for an A1 oscillation halt:

```json
{
  "envelope": {
    "sequenceNumber": 23,
    "eventType": "safetyHalt",
    "timestamp": "2026-05-08T14:25:01.789Z",
    "runId": "20260508-142301-a3f2"
  },
  "safetyClass": "loopDetected",
  "role": "gan-generator",
  "payload": {
    "reason": "editOscillation",
    "attempts": 3,
    "ceiling": 3,
    "evidence": {
      "detectedPattern": "3cycle",
      "fingerprintSequence": ["a3f2...", "b8e1...", "a3f2..."]
    }
  }
}
```

## Acceptance criteria

### Automated checks

- A completed sprint produces a trace directory containing every orchestrator milestone, every agent attempt, every LLM call, and every tool call from start to finish.
- All events validate against `schemas/run-trace-v1.json`.
- The index file at `index.json` validates against `schemas/run-trace-index-v1.json`.
- Two LLM calls with identical content payloads produce identical `promptRef` hashes (hash-boundary determinism).
- Two LLM calls differing only in temperature or seed produce identical `promptRef` hashes (hash-boundary correctness).
- Setting `telemetry.tracePayloads: hashed` in the user overlay produces a trace with hashes but no payload files.
- An A1 halt writes a `safetyHalt` event with `safetyClass = "loopDetected"`.
- An F4 trust prompt resolution writes a `trustEvent` event with the correct `userChoice`.
- A `validateAll()` failure that aborts the run writes a `validationAbort` event.
- An O2 archive of a halted sprint includes the trace directory; `--recover` reads it and resumes attempt-counter state without an external counter file.
- Trace files are gitignored by F1's `.gitignore` and never committed to user repos.
- A reader implementing only v1 schema knowledge tolerates an unknown discriminator value within a known event class without erroring.
- A SIGKILL during an event write leaves either a complete event file or no event file (atomicity contract).
- A run with a malformed event envelope is filtered out by `--list-recoverable`.

### Manual review checks

- The trace lives entirely under `.gan-state/`; no trace files appear in zone 1 or zone 3 (verifiable but worth a manual scan during PR review).
- The release notes document the storage-and-retention model so users know `.gan-state/` size grows without automatic cleanup.
- The hashed-mode rationale is visible to a privacy-conscious reader at the spec level (not buried in implementation).

## Dependencies

- F1 (zone semantics for `.gan-state/runs/<id>/trace/`)
- F3 (schema authority for `run-trace-v1` and `run-trace-index-v1`)
- C3 (overlay splice point `telemetry.tracePayloads`)
- E1 (orchestrator emits the events)
- O2 (recovery reads the trace)
- F4 (trust events that T1's `trustEvent` class records)
- A1 (reads `agentAttempt` events for ceiling tracking; writes `safetyHalt` events on halt — A1 depends on T1's schema being landed first)

## Bite-size note

Sprintable as:

1. (one sprint) Schema authoring (`run-trace-v1.json` and `run-trace-index-v1.json`) for envelope and seven event classes including extension-point design for `safetyHalt`.
2. (one sprint) Orchestrator emission of `orchestratorMilestone` and `agentAttempt` events.
3. (one sprint) `llmCall` event emission with payload references and hash-boundary contract.
4. (one sprint) `toolCall` event emission and `payloads/` storage layout.
5. (rides with F4 work) `trustEvent` emission integrated with the trust prompt code path.
6. (one sprint) `validationAbort` integrated with `validateAll()` error path.
7. (one sprint) `telemetry.tracePayloads` overlay splice + redaction logic + durability invariants (atomic writes, index reconciliation).

Slices 1–4 are sequential; slices 5–7 can land in any order after slice 1.
