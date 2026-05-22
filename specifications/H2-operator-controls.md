# H2 — Operator controls: run halt and mid-run steering

## Problem

Once `/gan` starts a run, the operator has no graceful in-flight control. The only levers are *pre-run* flags (parsed before any agent spawns) and *post-hoc* recovery (`--recover` / `--cleanup`, per O2). A1 adds **automated** halts — loop/thrash detection, attempt ceilings, the sprint budget — but every one of those is the framework deciding to stop. There is no operator-initiated equivalent.

Two situations have no answer today:

- **The operator sees a run going wrong and wants it to stop cleanly.** The generator is three attempts into a misframed feature, or the evaluator is thrashing on a contract the operator now knows is wrong. The only options are Ctrl-C — which interrupts an agent mid-write and leans entirely on O2 to reconstruct run state — or waiting for the sprint to burn its budget. Neither is a clean, recoverable stop.
- **The operator wants to redirect a run without restarting it.** A one-line course correction ("the auth flow should use the existing session module, not a new one") currently requires killing the run, editing the spec or overlay, and re-running — discarding all in-run progress.

The structural gap: **the operator can shape a run before it starts and clean up after it ends, but cannot intervene while it is running.** A long-running adversarial loop is exactly the workload where mid-run intervention matters most — the cost of a wrong direction compounds across attempts and sprints.

H2 closes this with two operator primitives that are well-established in the long-running-agent literature: a **kill-switch** (a sentinel that halts the run cleanly and recoverably at the next tool boundary) and **steering** (a one-shot guidance note surfaced to the next agent). Both are expressed natively in the framework's existing primitives rather than bolted on.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes. The kill-switch extends H1's framework-owned PreToolUse hook (`gan-confine.sh`); steering uses the orchestrator's existing between-spawn artifact-parsing step (per `skills/gan/SKILL.md`). Both reuse A1's halt-and-recover representation, O2's recovery flow, and T1's trace events.
2. **Composable?** Yes. The kill-switch composes with A1's automated `safetyHalt` (same recoverable-halt path, new reason) and with O2's `--recover`. Steering composes with the contract/feedback artifact flow without touching it.
3. **Owns durable, structured state?** Yes. The control channel is a zone-2 directory under `.gan-state/runs/<run-id>/control/`; the halt and each surfaced steer note are recorded in `progress.json` and the run trace.
4. **Fits ecosystem boundaries?** Yes. Zone-2 run state, a framework-owned hook (H-series), CLI subcommands (R3 surface). No new zone, no new ownership lane.
5. **Stackable / composable vs. terminal?** Composable. Steering is repeatable across a run (surfaced once per write); the kill-switch is a reusable gate, not a one-time action.

Passes all five — infrastructure, not a terminal feature.

## Proposed change

### The control channel

Operator-control state for a run lives under `.gan-state/runs/<run-id>/control/` (F1 zone 2):

- `control/halt` — presence sentinel. Its existence, not its content, is the signal.
- `control/steer.md` — free-form guidance for the next agent. Surfaced once, then cleared.

The **supported interface** is the `gan` CLI (below); the operator does not hand-edit zone 2 in normal use, preserving F1's "zone 2 is framework-written" discipline. The CLI validates the run-id, refuses on terminal runs, records the action, and writes the control file on the operator's behalf.

**One deliberate exception** to the zone-2 hand-write rule: `touch .gan-state/runs/<run-id>/control/halt` by hand is a sanctioned escape hatch for the kill-switch *only*. A kill-switch that depends on a healthy MCP server or a responsive CLI is not a kill-switch — the whole point is that it works when other things are wedged. The exception is narrow: it covers the `halt` presence sentinel and nothing else. Steering always goes through the CLI so its content is recorded to the trace before it reaches an agent.

### Kill-switch (operator halt)

The framework-owned confinement hook gains a **halt check that takes precedence over all other hook logic**. On every PreToolUse, when `GAN_RUN_ID` is set and `.gan-state/runs/${GAN_RUN_ID}/control/halt` exists, the hook denies the tool call with a clear message and a non-zero exit, regardless of what the call was. The currently-running agent stops at its next tool boundary.

The halt is **clean and recoverable**, not an error:

- The orchestrator detects the halted agent and records the stop using A1's recoverable-halt representation in `progress.json`, tagged with halt reason **`operatorHalt`**. The run stays recoverable — `/gan --recover` resumes from the last completed milestone exactly as it does after an A1 safety halt.
- The orchestrator writes a `safetyHalt` trace event (per A1 / T1) carrying the new **`operatorHalt`** discriminator, so the trace records *who* stopped the run (operator vs. loop-detector vs. budget) without a separate event class.
- No work is destroyed. The run branch and worktree survive for inspection, per the standard halt path.

`gan resume <run-id>` (or `/gan --recover --run-id <id>`) removes the `halt` sentinel and continues. Removing the file by hand and re-running `--recover` is equivalent — the sentinel's absence is all the resume path checks.

**Precedence in the hook (with A2).** A2 (v1.1) augments the same hook with per-sprint and per-role write-scope rules. H2's halt check runs **first**: halt (H2) → scope (A2) → zone (H1). A halted run denies every tool call before scope or zone logic is consulted. The three layers are independent and compose; none relies on another for its own correctness.

**Trust orthogonality.** Like H1's zone enforcement, the halt check fires on every PreToolUse regardless of trust rung. An `unsafe-trust-all` run is still haltable. The halt check does not consult trust state.

### Steering (mid-run course correction)

Between agent spawns — at the point where the orchestrator already parses the artifact each agent wrote and decides what to spawn next (per `skills/gan/SKILL.md` § "Spawn discipline") — the orchestrator checks for `control/steer.md`. When present and non-empty, it:

1. Copies the note's content into the run trace as an **`operatorSteer`** event (full content archived under T1's `payloads/`, for auditability).
2. Injects the content into the **next** spawned agent's initial context as a clearly-labelled *operator steering note*.
3. Clears `control/steer.md` (truncate-or-delete) so the note is surfaced exactly once.

The operator can write again to steer the agent after that — steering is repeatable, one note per spawn boundary.

**Steering is advisory, never a contract change.** This boundary is load-bearing and non-negotiable:

- A steer note is *additional guidance* the next generator / planner / proposer should heed. It cannot relax, add, or remove contract criteria, and it cannot reach the evaluator's scoring path.
- The evaluator continues to score against the **locked contract** only. Per PROJECT_CONTEXT § Conventions ("Measurement is separate from gating"), the LLM evaluator's PASS/FAIL on contract criteria remains the sole authoritative gate — steering must not corrupt the adversarial signal.
- An operator who wants to change *what "done" means* uses contract renegotiation (the proposer path, which the orchestrator already routes blocking-concerns through), not steering. The CLI's `gan steer` help text states this explicitly so the operator reaches for the right tool.

Steering is surfaced to the **next** agent, not the one currently running — H2 does not interrupt an in-flight agent to inject context. If the operator wants the *current* agent to stop first, they halt, steer, then resume.

### CLI surface

Three `gan` subcommands (R3 dispatch surface, same shape as the R5 `trust` subcommands):

- `gan halt [--run-id <id>]` — write `control/halt`. Default target is the most recent non-terminal run (same selection as `--recover`). Refuses on a terminal run. Idempotent.
- `gan resume [--run-id <id>]` — remove `control/halt`. Does **not** itself re-spawn agents; it clears the sentinel so the operator's `/gan --recover` (or an already-waiting orchestrator) proceeds. Idempotent — removing an absent sentinel is a no-op.
- `gan steer [--run-id <id>] (-m <text> | --from-file <path>)` — write `control/steer.md` from an inline message or a file. Refuses on a terminal run. Overwrites any unconsumed prior note (last write wins; the operator is steering *now*).

`--run-id` reuses O2's existing modifier and id format. These surfaces land in `runtime-knobs.md` in the implementation PR (per the runtime-knob convention), not at spec-authoring time — consistent with H1's `gan hooks status` not yet appearing in the table.

### Relationship to H1 (no edit to H1)

H2 changes the *behavior* of the framework-owned confinement hook by adding the halt precedence check to the hook template H1 owns. Per the "Implemented specs are immutable" rule, H1's prose is **not** edited: by the time H2 is implemented, H1 has shipped. H2 owns the new hook behavior (the halt check), the new control channel, the new trace discriminator/event, and the three CLI subcommands. Readers of H1 find H2's halt extension via the roadmap cross-reference, exactly as they find A2's scope extension. The hook remains regenerated from a single framework-owned template on each `install.sh`; H2's implementation extends that template.

### What H2 does not do

- **No in-place process suspend/resume.** Halt = stop at the next PreToolUse boundary and recover later. The agent is not frozen mid-tool-call; an already-issued tool call completes, and the *next* one is denied.
- **No contract mutation via steering.** Criteria changes go through the proposer; steering is advisory context only.
- **No interruption of the currently-running agent for steering.** Steer notes reach the next spawn. Halt-then-steer-then-resume is the pattern for redirecting the current agent.
- **No bidirectional chat with a live agent.** The control channel is one-way operator → run.
- **No cross-platform hook portability.** Bash on macOS / Linux per the framework's platform priority (PROJECT_CONTEXT § Platform priority). Windows is out of scope.
- **No new authority over zone 1 or trust.** Operator controls live entirely in zone-2 run state and the framework-owned hook.

## Schema additions

- **`run-trace` schema (owned by T1):** a new `safetyClass` value `operatorHalt` on the existing `safetyHalt` event class, and a new `operatorSteer` event class capturing `{ sprintNumber, attempt, payloadRef }`. Both are additive — they stay on the current `run-trace-v1` per the additive schema rule (H2 is post-v1.0). The implementation PR lands the schema change; behavior is documented here.
- **`progress.json` (owned by O2):** the operator halt reuses A1/O2's recoverable-halt representation with halt reason `operatorHalt`. If O2's halt-reason field is a closed enum at implementation time, this is an additive value; no new field is introduced.

H2 introduces no new JSON Schema *document* and no new splice point.

## Examples

Halting and resuming a run:

```
$ gan halt
Halt requested for run 20260521T140330-9a1c (most recent non-terminal run).
The run stops at the next tool boundary. Resume with:
  gan resume --run-id 20260521T140330-9a1c
  /gan --recover --run-id 20260521T140330-9a1c

$ gan resume --run-id 20260521T140330-9a1c
Halt sentinel cleared for run 20260521T140330-9a1c.
Resume the run with `/gan --recover --run-id 20260521T140330-9a1c`.
```

Steering the next agent:

```
$ gan steer -m "Reuse the existing session module under src/auth/session.ts; do not introduce a second session store."
Steering note recorded for run 20260521T140330-9a1c.
It will be surfaced to the next agent once, then cleared.
Note: steering is advisory. To change what the sprint must satisfy, the
contract is renegotiated by the proposer — steering does not alter criteria.
```

The hand-edit escape hatch (when the CLI or server is unavailable):

```
$ touch .gan-state/runs/20260521T140330-9a1c/control/halt
# The framework-owned hook denies the next tool call; the run halts cleanly
# and stays recoverable.
```

## Acceptance criteria

### Automated checks

- With `GAN_RUN_ID` set and `control/halt` present, the framework-owned confinement hook denies an in-worktree write that it would otherwise allow (halt takes precedence over the zone-allow path).
- With `GAN_RUN_ID` set and `control/halt` absent, the hook's allow/deny behavior is byte-for-byte unchanged from H1 (and, where A2 has shipped, from A2's scope augmentation).
- The halt precedence holds at every trust rung: a run with `GAN_TRUST=unsafe-trust-all` is still denied tool calls while `control/halt` exists.
- A run halted via the kill-switch is marked recoverable (not terminal) in `progress.json` with halt reason `operatorHalt`, and a `safetyHalt` trace event carrying the `operatorHalt` discriminator is written.
- `/gan --recover` (or `gan resume` followed by `--recover`) on an operator-halted run resumes from the last completed milestone — the same recovery assertion A1's halt path satisfies.
- `gan halt` with no `--run-id` targets the most recent non-terminal run; `gan halt --run-id <id>` targets exactly that run; both refuse on a terminal run.
- `gan resume` removes the sentinel and is a no-op when the sentinel is absent.
- `gan steer -m <text>` writes `control/steer.md`; the orchestrator surfaces its content to exactly one subsequent agent spawn, archives the content to the trace as an `operatorSteer` event, then clears the file; the following spawn sees no steer note unless the operator writes again.
- A steer note present during a sprint does **not** change the criteria the evaluator scores against: an evaluation run with and without a steer note produces the same contract criteria set (steering reaches the generator's context, never the evaluator's scoring path).
- The hand-touched `control/halt` sentinel (no CLI involved) produces the same hook denial as the CLI-written sentinel.

### Manual review checks

- The `gan steer` help text states that steering is advisory and points the operator at contract renegotiation for criteria changes.
- All user-facing strings (`gan halt` / `resume` / `steer` output, the hook's halt-denial message) obey the F4 prose-discipline rule and the iOS-developer-on-macOS readability check.
- The spec does not edit H1, A1, O2, or T1 prose; H2 owns its new behavior and the schema additions are listed here for the implementation PR to land (per "Implemented specs are immutable").
- The control-channel zone-2 hand-write exception is documented as narrow (the `halt` sentinel only) and justified (kill-switch robustness), and steering is confirmed to flow through the CLI so its content is recorded.

## Dependencies

- **H1** — framework-owned confinement hook. H2 adds the halt precedence check to the hook template H1 owns; H1 itself is shipped and is not edited.
- **A1** — loop & thrash detection. H2 reuses A1's recoverable-halt representation and the `safetyHalt` trace event, adding the `operatorHalt` reason/discriminator.
- **A2** — generator scope enforcement. Composes with H2 in the same hook; H2 defines the halt → scope → zone precedence. (A2 and H2 are both v1.1; whichever lands second states the composition — H2 states it here.)
- **O2** — recovery. Operator halts are recovered through O2's existing `--recover` flow; `gan halt`/`resume` reuse O2's run-selection and id format.
- **T1** — structured run trace. Owns the `run-trace` schema H2 extends with the `operatorHalt` discriminator and the `operatorSteer` event class.
- **F1** — filesystem layout. The `control/` directory is zone-2 run state; H2 carves the narrow hand-write exception for the `halt` sentinel.
- **F4** — threat model & trust. The halt check is trust-orthogonal, mirroring H1's confinement guarantee.
- **R3** — CLI wrapper. H2 adds `gan halt` / `gan resume` / `gan steer` to R3's dispatch surface; R3 itself is shipped and is not edited.

## Bite-size note

Sprintable as:

1. (one sprint) Hook halt-check: extend the framework-owned hook template with the `control/halt` precedence check; behavioral tests for the path set (halt present → deny; halt absent → unchanged; every trust rung → deny). Lands the precedence-order assertion against A2 if A2 has shipped.
2. (one sprint) Orchestrator halt handling: detect the halted agent, record `operatorHalt` in `progress.json` via A1's recoverable-halt path, write the `safetyHalt`/`operatorHalt` trace event, verify `--recover` resumes.
3. (one sprint) Steering: orchestrator between-spawn check, one-shot surface-and-clear, `operatorSteer` trace event with payload archival, the advisory-not-contract boundary test.
4. (one sprint) CLI: `gan halt` / `gan resume` / `gan steer` subcommands, run-selection reuse, terminal-run refusal, help text; `runtime-knobs.md` table additions.
5. (rides with the implementation PR) Trace-schema additions (`operatorHalt` `safetyClass` value, `operatorSteer` event class) landed against T1's `run-trace-v1`.

Slices 1–2 land in order; slice 3 depends on the orchestrator changes in 2; slice 4 depends on 1–3; slice 5 rides with whichever slice first emits the new trace shapes.
