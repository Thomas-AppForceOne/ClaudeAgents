# T4 — Run-configuration trace record

## Problem

The run trace records the concrete model per `llmCall` and a hash of each agent's inputs per `agentAttempt`, but nothing readable about the configuration that governed the run as a whole — framework version, resolved config, active stacks, agent roster, trust posture, or the harness knobs (thresholds, ceilings, enforcement modes). Two consequences:

- **Debugging is blind to configuration.** "Why did this run behave differently?" can't be answered from the trace when the difference is a threshold, an active stack, `--no-project-commands`, or a framework version. The hashes prove inputs differed; they don't say what the run-level config was.
- **Cross-run comparison has nothing to group by.** V1's verdict-accuracy harness (v2.0) must control for harness shape across runs, or it mixes runs produced under different configurations. There is no run-level configuration identity to key on.

T4 adds one trace event class, `runConfiguration`, emitted once per run at orchestrator start, that records it.

### Five-question relevance filter

1. **Plugs in?** One more event class in the run trace, emitted by the orchestrator from the F2 snapshot.
2. **Composable?** Read by T2 (cost), O3 (telemetry segmentation), V1 (cross-run comparison), and the model-upgrade audit — no bespoke logging.
3. **Durable state?** A schema-validated zone-2 trace event.
4. **Fits boundaries?** An additive new event class on `run-trace-v1`; no new zone, no new schema document.
5. **Composable vs. terminal?** A substrate multiple consumers read.

## Proposed change

### The `runConfiguration` event class

Emitted once per run at orchestrator start, before any `agentAttempt`. Fields:

- `frameworkVersion` — semver of the framework that produced the run (per I3).
- `apiVersion` — Configuration API version (per F2's `getApiVersion`).
- `configDigest` — SHA-256 of the frozen resolved-config snapshot (the enriched `getResolvedConfig()` view), excluding run-id and timestamps. Config-only and run-level — distinct from per-attempt `inputDigest`, which also hashes the prompt. Identical resolved config ⇒ identical digest. Sorted-key JSON per F3 determinism.
- `activeStacks` — `{name, tier}` per active stack (C5 tier provenance), readable, not hashed.
- `roles` — the spawned roster, each `{role, model}` with its configured model. The concrete per-call version stays in `llmCall.model`; pre-C6 the configured value may be an alias (e.g. `opus`).
- `trustRung` — effective trust posture (F4 vocabulary: `approved` | `runWithoutProjectCommands` | `unsafeTrustAll`).
- `tracePayloadsMode` — `full` | `hashed` (per T1's `telemetry.tracePayloads`).
- `safetyKnobs` — an open map of resolved harness knobs the orchestrator reads from the snapshot at emission: the default per-criterion threshold, A1's attempt ceilings and sprint budget, A2's scope-enforcement mode — whichever are resolvable. Readers tolerate unknown keys; an unresolved knob simply does not appear.

The event is configuration metadata only — never repo content — so it is recorded identically under `tracePayloads: full` and `hashed`.

It is a new event class added additively to `run-trace-v1` (the schema admits new event classes on v1 and readers already tolerate unknown event types). The implementation PR lands the schema member and the orchestrator emission.

## Schema additions

- **`run-trace-v1.json`:** a new `runConfiguration` member of the event union, with the fields above. Additive; no version bump. `schemas/` remains the canonical inventory of field shape.

## Examples

```json
{
  "envelope": {
    "sequenceNumber": 0,
    "eventType": "runConfiguration",
    "timestamp": "2026-05-22T10:15:00.001Z",
    "runId": "20260522T101500-4b2e"
  },
  "frameworkVersion": "1.1.0",
  "apiVersion": "0.1.0",
  "configDigest": "9f2c8a1b...e7a1",
  "activeStacks": [{ "name": "web-node", "tier": "builtin" }],
  "roles": [
    { "role": "gan-planner", "model": "opus" },
    { "role": "gan-contract-proposer", "model": "opus" },
    { "role": "gan-contract-reviewer", "model": "opus" },
    { "role": "gan-generator", "model": "opus" },
    { "role": "gan-evaluator", "model": "opus" }
  ],
  "trustRung": "approved",
  "tracePayloadsMode": "full",
  "safetyKnobs": { "defaultThreshold": 7, "generatorAttemptCeiling": 3, "sprintBudget": 12 }
}
```

## Acceptance criteria

### Automated checks

- Exactly one `runConfiguration` event per run, carrying the lowest sequence number, before any `agentAttempt`.
- The event validates against `schemas/run-trace-v1.json`.
- Identical resolved config ⇒ identical `configDigest`; any resolved-config difference ⇒ different `configDigest`.
- `roles` covers every agent role the orchestrator spawned, each with its configured model.
- The event is byte-identical under `telemetry.tracePayloads: full` and `hashed`.
- A v1-only reader tolerates unknown `safetyKnobs` keys without erroring.
- Existing `run-trace-v1` tests stay green (no other event's shape changes).

### Manual review checks

- All user-facing strings obey the F4 prose-discipline rule.

## Dependencies

- **T1** — owns `run-trace-v1` and the trace-emission path; the new class is additive to it.
- **F2 / C5** — resolved snapshot and tier provenance; source for `activeStacks`, `configDigest`, `roles`, `safetyKnobs`.
- **I3** — framework version source for `frameworkVersion`.
- **F4** — trust-posture vocabulary for `trustRung`.
- **A1 / A2** — knob owners whose resolved values the emission records into `safetyKnobs`.

## Bite-size note

1. (one sprint) Schema: add the `runConfiguration` member to `run-trace-v1.json`; round-trip validation + unknown-`safetyKnobs`-key tolerance tests.
2. (one sprint) Orchestrator emission at run start from the resolved snapshot; `configDigest` determinism + redaction-identity tests.

Slices land in order.
