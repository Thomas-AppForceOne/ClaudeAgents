# D1 — Diagnostic clarity

## Problem

The first dogfooding session caught three diagnostic surfaces producing the wrong remediation for the user's actual situation. In each case the framework has (or can obtain) the information to guide the user precisely. **Surface #1 (Config-API-unreachable) is net-new mechanism, not a refinement:** the framework has **no** preflight reachability check or `ConfigApiUnreachable` error of its own today (grep-confirmed: the code, the remediation prose, and the error enum entry are all absent), so the lumped message the session hit was Claude Code's generic MCP surface, not the framework's — D1 **introduces** the framework preflight. The other two are **not** message-refinements: #2 is a new SKILL.md status-marker *discipline* (plus a lint), and #3 is *verify-only* (R6 already shipped the help). What unites all three is one discipline — match the surface to the user's actual state — not that they are all message edits.

1. **Config-API-unreachable has no framework preflight — D1 introduces one (net-new, not polish).** Today, when the Configuration API is unreachable, the user sees only Claude Code's generic MCP-unreachable surface; the framework has no preflight of its own. A naive single remediation ("Install the framework: `bash <repo>/install.sh`. Then restart Claude Code.") is misleading for a user who already ran `install.sh` and just hit the restart-required mode — they need to restart Claude Code so the live session picks up the freshly-registered background service, not re-install. So D1 **builds net-new mechanism**: an **orchestrator** preflight (in `SKILL.md`, before `validateAll()` or any framework API call) that reads `~/.claude.json`, stats the registered bin, and probes reachability, then emits a **hand-authored diagnostic JSON** with a `ConfigApiUnreachable` code + `subReason` discriminator (the three sub-checks below). **This is orchestrator-emitted, not a server/CLI structured error:** the preflight fires precisely when the framework's MCP server is unreachable, so the markdown orchestrator cannot call into the server to build a `ConfigServerError` — it writes the diagnostic itself. So D1 adds **no** `errors.ts` `ErrorCode` entry and **no** CLI exit-code-map entry (those would be dead code — no CLI path emits this). It reconciles with the shipped CLI-side `ApiUnreachable` (exit 5, `run-helpers.ts`): that is the `gan` *CLI*'s "can't load the library" code; D1's `ConfigApiUnreachable` is the *orchestrator*'s "MCP server unreachable in this session" sibling — distinct actors, distinct surfaces, cross-referenced so the near-homonym is intentional, not a collision.

2. **SKILL.md described not-yet-operative behavior with no marking.** The orchestrator skill describes emitting trace events and running loop-detection halts as if live, but those are only operative once R7 (the runtime invocation bridge) exposes the trace/safety libraries to the markdown orchestrator. A reader — or an orchestrator implementing the skill from scratch — has no signal that the behavior is aspirational until R7 lands; the doc reads as if operative when it isn't. (The original dogfooding instance was `--recover`/`--list-recoverable`; those now ship in v1.0 — minimal recovery via O2, made operative by R7 — so the live instance of this problem is the trace/safety integration sections R7 turns real.)

3. **`gan stacks --help` completeness — already shipped; D1 only verifies.** An earlier draft of this problem claimed the help listed only 2 of 6 subcommands. That is **stale**: R6 (#16) already ships the full output — `help.ts` lists all six (`list` / `available` / `new` / `where` / `customize` / `reset`), the "Active vs. available" paragraph, and the `--tier` / `--force` flags. So D1's stacks-help work is a **verification** that this stays complete — there is no rewrite. (D1's real deliverables are #1's `ConfigApiUnreachable` preflight and the SKILL.md status markers.)

All three are diagnostic-surface failures: the framework had the data to guide the user well, and didn't. D1 covers all three because they share a discipline — match the diagnostic to the user's actual state, not to the most-common case.

### Why this matters for v1.0 (and beyond polish)

D1 reads like a polish pass — better error messages, marker tokens, fuller help text. It is not. Diagnostic clarity is **agent-readiness investment** with a direct line to evaluator quality:

- **Cleaner human diagnostics produce cleaner trace data.** When the orchestrator's preflight check emits a `subReason` discriminator (per the `ConfigApiUnreachable` branching below), the trace records that discriminator alongside the run's other events. Aggregated across many runs, the trace data answers questions like "what fraction of new-user friction is `notLoadedInSession` vs. `binMissing`?" Without the discriminator the data is unstructured prose; with it the data is queryable.
- **Cleaner trace data produces better evaluator feedback.** T1's evidence bundle (per T1's "Evaluator evidence bundle" subsection) joins criterion verdicts to trace events via `traceEventRefs`. When diagnostic events carry structured fields, the evaluator can cite specific events as evidence; when diagnostics are prose, the evaluator's `deltaFromContract` falls back to paraphrase.
- **Cleaner status markers prevent silent drift between what the spec promises and what the orchestrator does.** The `[shipped-in-vN]` / `[deferred-to-vN]` / `[partial-vN]` discipline is the same idea applied to spec-vs-runtime alignment. A spec that promises behavior the runtime doesn't deliver is the diagnostic-clarity failure mode at spec scale.

The investment is small (the three changes below) and the leverage is large — every later evaluator-side spec (V1, V2, V3 in v2.0; the Q-series in v1.2) reads cleaner data because of it. Treating D1 as polish under-prices the work and risks deferring it for "real" features that benefit from D1 having shipped first.

D1 is the first spec under the **D** (diagnostics + user UX) phase code.

## Proposed change

### `ConfigApiUnreachable` branching

The orchestrator's preflight check, before calling `validateAll()` or any other framework API, runs three sub-checks:

1. **Is the framework's MCP server registered in `~/.claude.json`?** Read `~/.claude.json` (or the platform-equivalent), check for the `mcpServers.claudeagents-config` entry.
2. **Does the registered command resolve to an existing executable?** If the registration is present, check whether the command path (absolute, per I3) exists and is executable.
3. **Are framework MCP tools actually reachable in this Claude Code session?** Attempt a single MCP probe (e.g. `getApiVersion()`) and see if the response arrives.

The remediation branches on the combination:

| #1 registered? | #2 bin exists? | #3 reachable? | Remediation |
|---|---|---|---|
| No | — | — | Install: `bash <repo>/install.sh`. Then restart Claude Code. |
| Yes | No | — | Re-install: the registered bin path `<path>` does not exist. Run `bash <repo>/install.sh` to refresh the registration. |
| Yes | Yes | No | Restart Claude Code. The framework is installed but this session has not loaded the MCP registration yet — Claude Code reads `~/.claude.json` only at session startup. Quit Claude Code completely (Cmd+Q on macOS) and reopen, then re-run `/gan --print-config`. |
| Yes | Yes | Yes | (No diagnostic; the API is reachable.) |

The third branch is the load-bearing addition: a user who already installed and just needs a restart no longer cycles through "I already installed, why is it telling me to install?"

The branches are deterministic from the framework's perspective — `~/.claude.json` is readable by the orchestrator, and the registered bin path is stat-able. The "is the API reachable" check is the natural fallback because if it succeeds, no diagnostic fires anyway.

### SKILL.md status markers

The orchestrator skill spec (`skills/gan/SKILL.md`) and any other forward-looking spec MUST mark sections with status indicators when the behavior they describe is not fully shipped in the current release:

- `[shipped-in-v1.0]` — operative now; the orchestrator implements this section as written.
- `[deferred-to-v1.1]` — described for forward-compat, not yet operative; the orchestrator either no-ops, prints a "this command requires v1.1" message, or short-circuits to a different flow.
- `[partial-v1.0]` — minimal viable shipped, full version in a later release; the section names which parts are operative.

The markers appear at section-heading level in the spec (e.g. immediately after `## Inspection and recovery short-circuits`). They are also reflected in the orchestrator's behavior:

- A section genuinely marked `[deferred-to-v1.1]` (e.g. the full operator-control surface H2 adds) short-circuits with a structured "this command requires v1.1; install the latest framework" message and exits non-zero, instead of silently no-oping or attempting an undefined dispatch.
- By contrast, `--recover` and `--list-recoverable` ship in v1.0 — minimal trace-driven recovery (O2), made operative by R7 — so they dispatch normally and are marked `[partial-v1.0]` / `[shipped-in-v1.0]`, not deferred. The marker must track what actually ships, which is exactly the drift this discipline prevents.

The orchestrator's runtime behavior aligning with the spec's markers is the contract that makes the markers meaningful. Without the runtime alignment, markers are just decoration.

The discipline applies prospectively to all forward-looking specs (A1, T1, E5 as they ship in stages; future H-series, V-series, B-series, Q-series specs). When a section's behavior moves from `[deferred-to-vN]` to `[shipped-in-vN]`, the marker updates in the same PR as the implementation. When a partial implementation lands, the section either splits (operative parts marked `[shipped]`, remaining parts `[deferred]`) or carries the `[partial]` marker with explicit per-bullet annotations. Concretely, `SKILL.md`'s `## Cleanup and recovery` heading covers **two** flows of different status — `--recover` `[partial-v1.0]` and `--cleanup` `[deferred-to-v1.1]` (per O2) — so the markers go **per-flag** under the heading (as the example below shows for `--recover`/`--list-recoverable`), never a single marker on the shared heading.

A new maintainer-tooling lint, **`lint-status-markers`** (a new `scripts/lint-status-markers/` joining R4's harness — **not** an edit to the shipped R4 spec), wired into CI as its own `test-status-markers.yml` per the locked CI inventory (one `test-<category>.yml` per script, riding `shared-setup.yml`, per R4). It scans **`skills/gan/SKILL.md`** (and any forward-looking spec file that opts into markers) and asserts exactly two things, both deterministic and CI-runnable with no LLM:

- Every **runtime-behavior** section heading in `SKILL.md` carries a status marker. (`SKILL.md` has no "Problem"/"Bite-size note" prologue — that carve-out is for *spec files* that opt in. `SKILL.md`'s pure-discipline/invariant sections — e.g. snapshot-freshness, per-run-state-vs-config, error-surfacing, spawn-discipline — carry `[shipped-in-v1.0]` because the invariant is operative now; they are not features and are not subject to any behavioural demand.)
- Markers reference releases that exist in the roadmap (no `[shipped-in-v9.9]`).

**The lint does NOT attempt to verify a `[shipped-in-v1.0]` flow actually runs** — that is the release-gate dogfood's job. CI has no LLM, so a markdown lint cannot prove an LLM-driven orchestrator section (the R7-wired trace/safety/recovery/renegotiation flows) executes; an earlier draft's "exercised by a test except LLM-driven sections" clause is **dropped** (it named no deterministic mechanism for "is this section LLM-driven?" and had no AC). The CI-tested tool-level mechanics (R7's parity/decision checks) plus the dogfood carry behavioural assurance; the marker lint carries only marker presence + roadmap validity.

### `gan stacks --help` completeness

The R3 CLI's stacks-help registry **already** lists all six subcommands and distinguishes `list` (active, detection-driven) from `available` (all shipped) — R6 (#16) shipped this. D1 **verifies** it remains complete and changes nothing; the example below documents the already-shipped output (note its header is `Flags:`, not `Options:`).

The shipped help **already includes** (R6 #16) the "Active vs. available" paragraph (rendered inside the subcommand `description`, *before* the `Flags:` block — per `src/cli/lib/help.ts`), examples like `gan stacks available` and `gan stacks customize web-node`, and the always-appended Global-flags / Examples / Exit-codes blocks. D1 verifies they remain present and **adds nothing**. `gan stacks list`'s runtime output is unchanged for scripting compatibility — tests pin the format (one stack name per line, `(none)` on empty active set).

D1 does **not** reproduce the full `--help` output verbatim here: a hand-copied block risks drifting from the live output (e.g. the block ordering), which is the exact churn the verify-only AC forbids. The authority is the shipped `help.ts`; D1's AC asserts completeness against it.

### What D1 does not do

- Address every diagnostic surface in the framework. The three covered here are the ones that bit a real dogfooding session. Future diagnostic improvements get their own specs (D2, D3, …) when usage signal warrants.
- Provide internationalization. All diagnostic messages are English; localization is post-v2.0.
- Provide structured-error machine output. The diagnostic messages are prose for humans; machine consumers read structured-error JSON via the F2 error model, which is unchanged.
- Cover the orchestrator's runtime telemetry surface (per-LLM-call summary, sprint-end summary). That is T1's scope; the heartbeat and progress lines are runtime UX, not diagnostic.
- **Add status markers to `runtime-knobs.md`.** That file is the *design inventory* of flags/knobs; per its own header the **roadmap** (not the table) is authoritative for shipped status. The marker discipline applies to `SKILL.md` (the runtime-behavior surface), not the inventory — so e.g. `runtime-knobs.md`'s `--cleanup` entry deliberately describes the full operative surface (design intent) even though v1.0 ships only O2's stub; the v1.0 deferred-state lives in `SKILL.md`'s `[deferred-to-v1.1]` marker + the roadmap, not a per-entry inventory annotation.

## Field encodings

D1 introduces two new schema-bearing surfaces:

- **Status-marker tokens** in spec files — `[shipped-in-v<release>]`, `[deferred-to-v<release>]`, `[partial-v<release>]`. Token format: ASCII brackets, lowercase tokens, version segment matches roadmap release labels. Lint enforces.
- **`ConfigApiUnreachable` branching discriminator** — the orchestrator-emitted preflight diagnostic carries a `subReason` field with values `notRegistered` | `binMissing` | `notLoadedInSession`, alongside a `code: "ConfigApiUnreachable"` and `message`. This is **hand-authored JSON the orchestrator writes**, shaped *like* an F2 structured error (code + message) for familiarity, but it has **no schema home** — it is not an `errors.ts` `ErrorCode` nor an F2 `ConfigServerError` (the server is unreachable, so the orchestrator cannot build one). The discriminator lets advanced consumers (logs, future telemetry) distinguish the cases.

## Examples

The preflight diagnostic is a **standalone orchestrator-emitted object**, *not* O1's `--print-config` output: when the API is unreachable the orchestrator cannot call `getResolvedConfig()`, so there is no resolved config to print and O1's flat `issues`/`warnings` shape never applies. The preflight short-circuits before O1's flow and emits its own diagnostic. (When the API *is* reachable, O1's flat resolved object is what prints — the two surfaces are disjoint.)

A user who has already installed but hasn't restarted Claude Code:

```
$ /gan --print-config
{
  "code": "ConfigApiUnreachable",
  "subReason": "notLoadedInSession",
  "message": "The framework is installed (`~/.claude.json` registers the background service at `/opt/homebrew/bin/claudeagents-config-server`) but this Claude Code session has not loaded it yet. Claude Code reads `~/.claude.json` only at session startup. Quit Claude Code completely (Cmd+Q on macOS) and reopen, then re-run `/gan --print-config`."
}
```

A user who has not run `install.sh` at all:

```
$ /gan --print-config
{
  "code": "ConfigApiUnreachable",
  "subReason": "notRegistered",
  "message": "The framework's Configuration API is not registered in this Claude Code installation. Install: `bash /Users/taa/AppForceOne/projects/ClaudeAgents/install.sh`. Then restart Claude Code."
}
```

A SKILL.md section with status markers:

```markdown
## Inspection and recovery short-circuits

`--print-config` [shipped-in-v1.0]
- Calls `validateAll()` in non-aborting mode.
- Calls the resolved-config read and emits the resolved object on stdout.
- Exit code reflects validation status.

`--recover` [partial-v1.0]
- Dispatches to the recovery flow. Minimal trace-driven resume ships in v1.0;
  the richer recovery UX lands in v1.1.

`--list-recoverable` [shipped-in-v1.0]
- Enumerates the central store's per-run progress files and prints recoverable runs.
```

Note the example carries **only** the `[…-v1.0]` marker tokens and **no** spec-reference prose (`O1`/`O2`/`R7`/`F7`, etc.) — D2 (shipped before D1) installs `lint-no-spec-ref` over `SKILL.md`, which rejects bare phase-codes and allowlists only the marker tokens. D1's real SKILL.md edits add markers, never phase-code citations.

(No verbatim `gan stacks --help` block here — it is the already-shipped R6 output; reproducing it would risk drift the verify-only AC forbids. The shipped `help.ts` is the authority: six subcommands, the "Active vs. available" paragraph rendered inside the `description` before `Flags:`, the `--tier`/`--force` flags under `Flags:`, and the appended Global-flags/Examples/Exit-codes blocks.)

## Acceptance criteria

### Automated checks

- A `/gan --print-config` invocation against an installation where `~/.claude.json` lacks the `mcpServers.claudeagents-config` entry produces `ConfigApiUnreachable` with `subReason: "notRegistered"` and the install-then-restart remediation.
- A `/gan --print-config` invocation against an installation where `~/.claude.json` has the entry but the registered bin path does not exist produces `ConfigApiUnreachable` with `subReason: "binMissing"` and the re-install remediation.
- A `/gan --print-config` invocation against an installation where the entry is present, the bin exists, but the MCP server is not reachable in the current session produces `ConfigApiUnreachable` with `subReason: "notLoadedInSession"` and the restart-only remediation.
- A `/gan --recover` invocation under v1.0 dispatches to the minimal recovery flow (O2, made operative by R7), not a "requires v1.1" short-circuit; `/gan --list-recoverable` enumerates recoverable runs. **This AC presupposes O2 has landed (see Dependencies → O2); it rides with O2's PR if D1 lands first.** A section genuinely marked `[deferred-to-v1.1]` short-circuits with the structured "requires v1.1" message and exits non-zero.
- The `lint-status-markers` script asserts every runtime-behavior section heading in `SKILL.md` carries a marker (pure-discipline/invariant sections carry `[shipped-in-v1.0]`; `SKILL.md` has no Problem/Bite-size prologue to exempt — that carve-out is for opted-in spec files).
- The lint script rejects markers referencing releases not present in the roadmap (e.g. `[shipped-in-v9.9]`).
- **Verify (not rewrite):** the shipped `gan stacks --help` already advertises all six subcommands, the "Active vs. available" paragraph, and the `--tier` / `--force` flags under its **`Flags:`** header (R6 #16). D1 asserts these remain present and **does not** rename `Flags:`→`Options:` or otherwise churn the shipped output.
- The `gan stacks list` runtime output format is unchanged (one stack name per line, `(none)` on empty set; existing tests still pass).

### Manual review checks

- The `notLoadedInSession` remediation explicitly names Cmd+Q (macOS) so users don't just close the window and assume restart happened.
- All three `ConfigApiUnreachable` branches' messages obey the F4 prose-discipline rule.
- The status markers in SKILL.md align with the actual orchestrator behavior — sections marked `[shipped-in-v1.0]` are operative; sections marked `[deferred-to-v1.1]` short-circuit with a structured "requires v1.1" message.

## Version bump: none

D1 changes **no installed-package surface**: the `ConfigApiUnreachable` preflight is orchestrator-emitted (hand-authored JSON in `SKILL.md`, copied every install — no `errors.ts` `ErrorCode`, no CLI command, no exit-code-map entry); the SKILL.md status markers are copied every install; the `lint-status-markers` script is maintainer/CI tooling, not installed; and `gan stacks --help` is already shipped by R6 and only verified. So no `package.json` bump is needed (per the pre-1.0 install-version bump discipline, roadmap § "Pre-release chores and release gate"). (Earlier drafts claimed a bump for a `ConfigApiUnreachable` *error code* + CLI exit-code entry; that was retracted — the preflight is orchestrator markdown, not a server/CLI change, so those entries would be dead code.)

## Dependencies

- **F2** — structured-error model (referenced, not extended). D1's preflight diagnostic is shaped *like* an F2 error (code + message + `subReason`) but is **orchestrator-authored JSON**, not a new `errors.ts` `ErrorCode` and not a CLI exit-code-map entry (the server is unreachable when it fires, so no `ConfigServerError` can be built — and there is no CLI path for `/gan --print-config`). It reconciles with the shipped CLI-side `ApiUnreachable` (the `gan` CLI's library-unreachable code, exit 5) as its orchestrator-side sibling — distinct surfaces, cross-referenced.
- **F4** — trust prompt context; the `notRegistered` remediation may also describe the trust-prompt sequence the user will encounter on first install.
- **E1** — orchestrator that emits the diagnostics; SKILL.md status markers ride with E1's spec ownership.
- **R3 (shipped) / R6 (#16)** — CLI help registry; `gan stacks --help` is **already complete** (R6 shipped the six subcommands + "Active vs. available" + flags), so D1 only **verifies** it — no R3 rewrite/amendment.
- **R4** — maintainer tooling; the `lint-status-markers` script is a new R4 addition.
- **O1** — observability; O1 owns `--print-config`'s **reachable-API** output: the flat `getResolvedConfig()` object whose own `issues`/`warnings` carry validation results — **no `validationErrors`/`resolvedConfig` wrapper** (O1 explicitly removed it). D1's `ConfigApiUnreachable` preflight is a **disjoint** surface that fires *before* O1's flow when the API is unreachable (so O1's resolved object cannot be produced); the two never co-emit, and D1 must **not** reintroduce the wrapper shape O1 dropped.
- **O2** — the minimal recovery flow that `--recover` / `--list-recoverable` dispatch to. D1 marks those flags `[partial-v1.0]` / `[shipped-in-v1.0]` and asserts (AC, below) that they dispatch rather than short-circuit — so **O2's recovery flow must exist when that AC runs.** In the implementation order **O2 (and O1/O3) are listed before D1**, so O2's recovery flow already exists when D1's `--recover` / `--list-recoverable` marker ACs run, and D1's status-marker lint sees every SKILL.md section — E8's, O2's, and the O-series' — already added. (D1 is sequenced last among the SKILL.md editors precisely so a `[shipped-in-v1.0]` marker never lands on a flow that has not been wired — the spec-vs-runtime drift D1 exists to prevent.)

## Bite-size note

Sprintable as:

1. (one sprint) `ConfigApiUnreachable` branching: orchestrator preflight check (in `SKILL.md`), three sub-checks, remediation routing, the orchestrator-emitted diagnostic JSON with the `subReason` discriminator (no `errors.ts`/CLI change).
2. (one sprint) SKILL.md status markers: token vocabulary, runtime alignment (deferred-flag short-circuits print "requires v1.1"), spec edits.
3. (one sprint) `lint-status-markers` script: parser, lint rules, CI workflow integration.
4. (trivial) `gan stacks --help` **verification** — R6 (#16) already ships the full output; D1 asserts completeness, no rewrite.

Slices are independent; can land in any order. Slice 3 must wait until slice 2 establishes the marker vocabulary.
