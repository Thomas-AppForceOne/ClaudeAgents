# O4 — Run-store, lock & recovery hardening

## Problem

Four operability defects make a wedged or lying run state possible, and three of them have already happened in the run corpus (see [`_audit-2026-06-12-structural.md`](_audit-2026-06-12-structural.md) findings 4, 10, 11, 12):

1. **The run lock can wedge a repo indefinitely.** `acquireRunLock` auto-breaks only dead-pid locks; the recorded pid is the long-lived config server, so a crashed *run* under a living *server* holds the lock forever (`ConcurrentRunInProgress` on every retry), and the same-runId `StrandedSelfLock` path's only documented escape is a raw `rm <lockPath>` — an instruction that violates the framework's own "no hand-edits in zone 2" discipline.
2. **Store-root resolution fails silent.** Any read error on the `~/.claude/gan/runs-data-dir` marker — EACCES, corruption, not just ENOENT — silently falls back to the default root: a user with a custom store gets a fresh empty store, prior runs "vanish", and `--recover` finds nothing, with no diagnostic anywhere.
3. **Repo-key drift orphans runs.** The store already contains two key dirs for this repo (`ClaudeAgents-dea5f7879cf0`, `claudeagents-5f2b0a723ee9`); runs under a superseded key are invisible to `--list-recoverable` with no hint they exist.
4. **Recovery guards are prose-only, and safety counters can be silently undercounted.** The malformed-`progress.json` and partial-feedback dispatch guards are marked `[deferred-to-v1.1]` in SKILL.md — recovery against a corrupt state document has *no defined behaviour* — and `appendTraceEvent` drops an emit after exhausting EEXIST retries with only a telemetry counter, so a dropped `agentAttempt` silently weakens A1's ceilings (the trace is the only counter, per A1).

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — hardens F7's store/lock, O2's dispatch, T1's append path; adds one CLI subcommand in R3's dispatcher pattern.
2. **Composable?** Yes — T2's read surfaces and any future operator tooling assume exactly the integrity guarantees added here.
3. **Owns durable structured state?** Yes — lock-file contents and the recovery-read contract over zone 2.
4. **Fits existing lanes?** Yes — structured errors via the F2 factory, knobs via `runtime-knobs.md`, no new ownership lane.
5. **Stackable?** Yes — every later run-store consumer inherits the guards.

## Proposed change

### 1. Lock lifecycle: terminal-holder auto-break + activity-aware refusal + `gan runs unlock`

- **Terminal-holder auto-break.** `acquireRunLock` reads the holder run's `progress.json`: if `terminal: true`, the lock is a leak (release-on-exit failed); it is broken and acquisition proceeds, with a structured warning naming the leaked holder. (Safe by construction — a terminal run never writes again.)
- **Activity-aware refusal.** For a live-pid, non-terminal holder, the refusal message now includes the holder's last trace-activity age (newest mtime under `<runDir>/trace/events/`). When that age exceeds the stale threshold (default **30 minutes**, overlay `safety.lockStaleMinutes`, additive), the error text names `gan runs unlock` as the sanctioned escape. Acquisition still refuses — breaking a possibly-live run stays a human decision.
- **`gan runs unlock [--run-id <id>] [--project-root <path>]`** — new R3-dispatcher subcommand: prints the holder (runId, pid, last-activity age, terminal status), requires confirmation (`--yes` bypass, existing flag), unlinks the lock, exits 0. Refuses with a warning when last activity is under the stale threshold unless confirmed. Retires the `rm <lockPath>` instruction from SKILL.md (E10/D3-era prose passes are coordinated; the retirement row lands here).
- **`StrandedSelfLock` self-heals on `--recover`.** A same-runId re-acquisition during recovery re-adopts the existing lock (it *is* this run's lock) instead of erroring.

### 2. Store-root integrity

- Marker read errors split by class: ENOENT → default fallback (legitimate); anything else → halt with new structured error **`StoreRootUnreadable`** (errors.ts + F2 enum) naming the marker path and a shell remediation. No more silent empty-store substitution.
- When the default root is used and the marker is absent, the startup log states the resolved store root explicitly (one line, non-suppressible class as W1 warnings) so "my runs vanished" is diagnosable from the transcript.

### 3. Legacy repo-key visibility

`--list-recoverable` (and the underlying store scan) additionally scans sibling repo-key dirs whose stored `progress.json.workspace.mainWorktreeRoot` matches the current repo root but whose key differs from the current derivation. Matches are listed in a separate "legacy key" section, read-only, with a one-line `mv <old> <new>` remediation. No auto-migration (pre-1.0, no shims).

### 4. Recovery guards become operative; safety-class trace drops halt

- **Malformed `progress.json`:** `--recover` against an unparseable/invalid progress document surfaces a structured `RecoveryStateCorrupt`-class failure (reusing `ValidationFailed` with a recovery-specific message — no new code) naming the file and offering `--cleanup --run-id <id>`; never undefined behaviour. The terminal-status reject (recovering a `terminal: true` run is refused with the reason) ships operative. SKILL.md's `[deferred-to-v1.1]` markers on these branches flip to `[shipped-in-v<release>]` in this PR (marker edits are SKILL.md content, not spec edits).
- **Partial-feedback guard:** with F9's atomic `writeRunArtifact`, a cleanly-parsing-but-truncated bundle can no longer exist; the `evaluating` dispatch branch now validates the bundle (read-side, against `evaluator-evidence-bundle-v1`) and discards + re-evaluates on failure — the read-side half of the contract F9's write-side made possible.
- **Safety-class drop halting:** `appendTraceEvent`'s post-retry drop path distinguishes event classes: dropping `agentAttempt`, `safetyHalt`, or `validationAbort` throws new structured error **`TraceWriteFailed`** (halting the run — an uncounted safety event is a corrupted safety substrate); all other classes keep the existing telemetry-counted drop. `droppedEmits` semantics for non-safety classes unchanged (O3 untouched).

## Schema additions

- `overlay-v1.json` — additive `safety.lockStaleMinutes` (integer minutes ≥ 1, default 30).
- F2 error enum + `errors.ts` — `StoreRootUnreadable`, `TraceWriteFailed`.
- `api-tools-v1.json` — additive input field on `acquireRunLock` only if the implementation needs the project root threaded (decided in PR; otherwise no entry changes).
- [`runtime-knobs.md`](runtime-knobs.md) — `gan runs unlock` subcommand row (owning spec O4); count 16 → 17 subcommands. Added in this spec's authoring PR per the drafted-inventory rule.

## Acceptance criteria

1. **Terminal leak self-heals.** Fixture: lock held by a run whose `progress.json` is `terminal: true`; `acquireRunLock` succeeds, emits the leak warning naming the old runId.
2. **Live holder still refuses.** Non-terminal holder with fresh trace activity → `ConcurrentRunInProgress`, message carries last-activity age; stale activity → message additionally names `gan runs unlock`.
3. **Unlock subcommand.** `gan runs unlock --yes` against a stale fixture lock unlinks it and exits 0; against a fresh-activity lock without confirmation, refuses non-zero. Help text passes the F4 error-text discipline (`lint-error-text` green).
4. **No `rm` instruction survives.** `grep -rn 'rm .*lock' skills/gan/ agents/` returns 0 hits.
5. **Marker errors split.** EACCES on the marker file halts with `StoreRootUnreadable`; ENOENT falls back and the startup log names the resolved root (asserted on fixture output).
6. **Legacy keys surfaced.** A fixture store with runs under a stale key for the same `mainWorktreeRoot` shows them in `--list-recoverable`'s legacy section with the `mv` hint.
7. **Corrupt progress defined.** `--recover` against truncated JSON surfaces the structured error + `--cleanup` hint; recovering a terminal run refuses with the recorded `terminalReason`. The two SKILL.md sections carry no remaining `[deferred-to-v1.1]` marker.
8. **Safety drops halt.** Unit test forces the 64-collision exhaustion path for an `agentAttempt` emit → `TraceWriteFailed` thrown; an `llmCall` emit on the same path → counted drop, no throw.
9. **`StrandedSelfLock` gone from recovery.** Same-runId `--recover` re-adopts the lock; the error remains only for genuinely-concurrent same-id collisions outside recovery.

## Version bump: minor

Server storage/lock behaviour, new CLI subcommand, new error codes, additive overlay field — installed-package changes; the PR minor-bumps `package.json`.

## Dependencies

- **F7 / O2 / T1 / A1** (shipped) — the store, recovery dispatch, trace append, and safety semantics being hardened; cross-referenced, never edited (all changes are additive code paths + SKILL.md content updates).
- **F9** (hard, for the partial-feedback guard) — the atomic write-side contract the read-side guard assumes. The lock/store/legacy-key work has no F9 dependency and may land first if sequencing demands.
- **R3** (shipped) — dispatcher pattern for the new subcommand; exit codes via the existing table.

## Bite-size note

One PR, two slices: (1) lock lifecycle + unlock subcommand + store-root/legacy-key integrity (~1 sprint); (2) recovery guards + trace-drop halting + SKILL.md marker flips (~0.5–1 sprint). Slice 1 is independent of F9 and can land while F9 is in review.
