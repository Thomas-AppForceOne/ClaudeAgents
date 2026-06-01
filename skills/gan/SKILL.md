# GAN — Adversarial Development Loop

Run a generative-adversarial development pipeline against a sprint plan. The full run begins by clarifying the user's prompt into an explicit spec, then planning from it, before the per-sprint loop: prompt → clarifier → planner → contract-proposer → generator → evaluator (the proposer → generator → evaluator stage loops per sprint). The orchestrator is a thin shell — every framework configuration value comes from the Configuration API. The orchestrator never parses stack files, overlay files, or YAML directly.

## Invocation

```
/gan "build a CLI todo app"
/gan --help
/gan --print-config
/gan --recover
/gan --list-recoverable
/gan --no-project-commands "review someone's branch"
```

## Argument parsing

Parse arguments from the user's message before doing anything else. The five flags below are mandatory in the new flag table; user-supplied flags such as `--spec`, `--target`, `--max-attempts`, `--threshold`, `--branch-name`, `--base-branch`, and `--label` continue to be honoured for sprint-shape control and telemetry.

| Flag | Default | Meaning |
|---|---|---|
| `--help` (also `-h`, `help`) | n/a | Print help text and exit 0. Runs BEFORE validation; no worktree, no agents. |
| `--print-config` | n/a | Inspection short-circuit. Calls `validateAll()` in non-aborting mode then `getResolvedConfig()` and prints the flat resolved-config object — any error-severity validation results appear in the resolved object's own `issues` array (with `warnings` in the parallel `warnings` array); no `resolvedConfig`/`validationErrors` wrapper. Exit code reflects validation status. No worktree, no agents. |
| `--recover` | n/a | Recovery short-circuit. Calls validation in non-aborting mode, dispatches to the recovery flow. No new worktree until recovery resumes. Without `--run-id`, targets the most recent non-terminal run; combine with `--run-id <id>` for a specific run. Recovery is bound to the run's recorded `workspace.worktreePath`: it refuses (non-zero) when invoked from any other worktree. See "Cleanup and recovery" below. |
| `--list-recoverable` | n/a | Inventory short-circuit. Calls validation in non-aborting mode, enumerates the repo's runs under the central store (`<store-root>/<repo-key>/runs/`) so every run is visible from any worktree, prints recoverable runs, exits. |
| `--cleanup` | n/a | `[deferred-to-v1.1]` v1.0 stub: invoking with any modifier prints the structured `this command requires v1.1` message, exits non-zero, and mutates nothing on disk. The full destructive surface (single-run / `--all` / `--include-terminal` / `--yes`, merge-aware run-branch deletion, on-disk reclaim) lands in v1.1. See "Cleanup and recovery" below. |
| `--run-id <id>` | n/a | Modifier for `--recover` and `--cleanup`. Names the specific run id to act on; the id format is `<YYYYMMDDTHHMMSS>-<4 hex>` (the directory name under `<store-root>/<repo-key>/runs/`). Use `/gan --list-recoverable` to list available ids. |
| `--no-project-commands` | false | Skip every command sourced from `project` and `user` tier files for this run; falls back to `builtin` tier defaults. |
| `--skip-welcome` | false | Skip the first-run welcome banner. The marker file at `~/.claude/gan/welcomed` is created so subsequent runs also skip the banner. Idempotent — passing this flag on an already-welcomed system is a no-op. See "Welcome banner" below. |
| `--max-attempts <n>` | from config | One-off override of the attempt ceilings for this run. Applies a **uniform** per-role ceiling of `n` to **every** multi-attempt role and sets the sprint-wide budget to `n × roleCount + 4` (the `+4` covers clarifier, planner, reviewer, and evaluator). It **overrides** the overlay's `safety.attemptCeilings.*` and `safety.sprintBudget`. Feeds the resolved effective ceilings and budget into the attempt-start checks (see "Safety halts — shared contract"). |
| `--reset-attempts` | false | Modifier valid only alongside `--recover`. When set, the recovered sprint resumes with attempt counters at zero; without it, recovery preserves the counters reconstructed from the trace (so a recovered sprint hitting the same loop halts again on the next attempt). |
| `--skip-clarification` | false | Bypass the clarifier; the orchestrator writes a minimal `clarified-spec.md` (the verbatim prompt as Goal) and proceeds straight to the planner. Does NOT short-circuit `validateAll()`. |
| `--clarifier-timeout=<seconds>` | from config (60) | Override the draft-preview auto-approve timeout for this run. Enforces the same `[10, 600]` range as the overlay splice; an out-of-range value (and `0`) is rejected at flag-parse time with `InvalidTimeoutValue`. |

Help output never references maintainer-only scripts. Help text points the user at the `gan` CLI (for example `gan stacks new`, `gan trust info`, `gan config print`) for configuration management, and at `.claude/gan/project.md` for overlay authoring.

The remaining text after flags is the user prompt passed to the planner (when a regular run is invoked).

**Bare invocation (`/gan` with no prompt).** A `/gan` invocation that carries no prompt and no agent-spawn-short-circuiting flag (i.e. not `--help`, `--print-config`, `--list-recoverable`, or `--recover`) is handled by the `NoPromptProvided` check inside the regular invocation flow. The check fires **after `validateAll()` and after the welcome banner** (when applicable), but **before the clarifier** and **before any run-lockfile is acquired or any run state is created** — a bare invocation never creates run state.

It halts with the structured error `NoPromptProvided`, carrying the exact user-facing message:

> No prompt provided. Run `/gan "<your prompt here>"` to start a sprint, or `/gan --help` to see the available options.

The `--help` hint is mandatory. The ordering is `validateAll()` → welcome banner → `NoPromptProvided`; see "Regular invocation flow" below for the precise step placement.

## Welcome banner

The first time `/gan` is invoked **as a regular sprint invocation** (not as a `--help`, `--print-config`, `--list-recoverable`, `--recover`, or `--cleanup` short-circuit), the orchestrator prints a multi-paragraph welcome banner before doing any other work, then continues with the requested action.

**Detection.** The marker file at `~/.claude/gan/welcomed` is the welcomed-state signal. Its presence — not its content — is what counts. The file is a zero-byte sentinel and lives under `~/.claude/gan/` (the configuration zone). The orchestrator checks for the file at startup; absence triggers the banner.

**Short-circuit exemption.** The banner does NOT fire on `--help`, `--print-config`, `--list-recoverable`, `--recover`, or `--cleanup`. The banner fires only when the orchestrator is about to spawn agents on a first-run system.

**Banner content** covers: what ClaudeAgents is, the pipeline shape (clarifier → planner → contract → generator → evaluator), what trust prompts and the clarifier draft preview look like, what `.gan-state/` accumulates, when to use `--no-project-commands`, where to find docs, and that both `gan` and `/gan` exist with separate purposes. The orchestrator renders this as prose that obeys the framework's prose-discipline rule: ecosystem package-manager and runtime tokens must appear inside backticks when they occur in user-facing prose, and are otherwise forbidden in user-facing strings.

**Marker-write timing.** The marker is written **after** the banner finishes printing but **before** any downstream agent fires. Ctrl-C during banner display does not write the marker — the user gets a re-show on next run. A user who wants to re-read the banner can `rm ~/.claude/gan/welcomed`.

**`--skip-welcome` flag.** Passing this flag writes the marker without printing the banner. Idempotent — the marker write is a no-op when the file already exists.

**Non-TTY behavior.** When stdin/stdout are not a TTY (CI, automated scripts), the banner is skipped silently and the marker is created.

## Help short-circuit

`--help` runs **before** `validateAll()`. The orchestrator prints the help text to stdout and exits 0. There is no validation, no snapshot, no worktree, and no agent is spawned. This is the only flag that skips validation entirely.

### Help text template

The orchestrator renders the help text in the following shape. The USAGE section gives each invocation's accepted shape with `[optional]` markers for modifiers; the FLAGS section gives each flag's description with its default value in parens at the end of the line.

```
GAN — Adversarial Development Loop

USAGE
  /gan "<prompt>" [SPRINT-OPTS]                            Run a sprint against the given prompt
  /gan --spec <path> [SPRINT-OPTS]                         Run a sprint from an existing spec
  /gan --help                                              Show this help text
  /gan --print-config                                      Print resolved configuration and exit
  /gan --list-recoverable [--include-terminal]             List runs eligible for recovery
  /gan --recover [--run-id <id>]                           Resume an interrupted run (default: most recent non-terminal)
  /gan --cleanup [--run-id <id>] [--yes]                   Delete one run (default: most recent non-terminal)
  /gan --cleanup --all [--include-terminal] [--yes]        Delete every non-terminal run (or every run with --include-terminal)

  SPRINT-OPTS = [--target <path>] [--max-attempts <n>] [--threshold <0-100>]
                [--branch-name <name>] [--base-branch <name>] [--label <text>]
                [--no-project-commands] [--skip-welcome] [--skip-clarification]
                [--clarifier-timeout=<seconds>]

FLAGS  (defaults shown in parens)
  --spec <path>                 Use an existing spec file instead of planning from scratch (none)
  --target <path>               Override the repo root (current repo top)
  --max-attempts <n>            Uniform per-role attempt ceiling for this run; also sets the
                                sprint budget to n x roleCount + 4. Overrides overlay config (3)
  --threshold <0-100>           Minimum evaluator score to pass a sprint (from resolved config)
  --branch-name <name>          Override the generated branch name (gan/<run-id>)
  --base-branch <name>          Override the base branch (develop)
  --label <text>                Tag this run for grouping in progress reports (none)
  --run-id <id>                 Target a specific run for --recover or --cleanup (most recent non-terminal)
  --all                         With --cleanup: target every non-terminal run (off)
  --include-terminal            Also include terminal (complete or failed) runs (off)
  --yes                         Skip the --cleanup confirmation prompt (off; prompt fires)
  --no-project-commands         Skip project- and user-tier overlay commands; use builtin defaults only (off)
  --skip-welcome                Write the first-run welcome marker without printing the banner (off)
  --skip-clarification          Bypass the clarifier; the orchestrator writes a minimal clarified spec
                                from the raw prompt and goes straight to the planner (off)
  --clarifier-timeout=<seconds> Override the draft-preview auto-approve timeout for this run; enforces
                                the [10, 600] range and overrides the draft-timeout overlay (60)

EXAMPLES
  /gan "add a contact form to the homepage"
  /gan --spec specifications/roadmap-vote.md
  /gan --recover
  /gan --recover --run-id 20260511T191658-7c43
  /gan --cleanup --all --yes
  /gan --print-config
  /gan --no-project-commands "review the deploy scripts"

CONFIGURATION
  Manage stacks:     gan stacks new <name>
  Inspect config:    gan config print
  Trust info:        gan trust info
  Overlay authoring: .claude/gan/project.md in your repo root

OUTPUT
  Per-run state lives in the central store at <store-root>/<repo-key>/runs/<run-id>/
  Branches are named gan/<run-id> and target develop (or the --base-branch override)
```

**Rendering rules:**

- **USAGE**: one line per invocation form, with `[optional]` markers around modifier flags. Where the default behaviour is non-obvious (e.g. `--recover` without `--run-id` targets the most recent non-terminal run), state the default at the end of the USAGE line in parens. Required values appear as `<placeholder>`; alternation is shown with `|` if needed.
- **FLAGS**: one line per flag, default in parens at the end of the description. `(none)` for flags with no implicit value; `(off)` for boolean flags that default to off; the literal default value otherwise. Booleans never need a `<value>` placeholder.
- **EXAMPLES**: realistic invocations covering at least one sprint form, one recovery form, one cleanup form, one inspection form, and one project-commands-skip form. Examples never reference maintainer-only scripts.
- **CONFIGURATION**: point the user at the `gan` CLI for configuration management (`gan stacks new`, `gan config print`, `gan trust info`) and at `.claude/gan/project.md` for overlay authoring. Obey the framework's prose-discipline rule: ecosystem-specific package-manager and runtime tokens are forbidden in user-facing prose outside backticks.
- **OUTPUT**: where per-run state lives and how branches are named. Mention the `--base-branch` override.

## Inspection and recovery short-circuits

`--print-config`, `--recover`, `--list-recoverable`, and `--cleanup` call `validateAll()` in **non-aborting mode**: any structured errors are captured and surfaced alongside the partial resolved view (for `--print-config`) or in the recovery / cleanup report (for `--recover` / `--list-recoverable` / `--cleanup`). The user can inspect a known-broken project's configuration or reclaim its run state without first fixing validation.

Specifics:

- `--print-config` calls `getResolvedConfig()` and emits the resolved-config object on stdout — byte-identical with `gan config print --json` for the same project state. The output is the flat resolved shape; when validation captured errors they appear inside that object's `issues` array (with non-aborting overlay-misuse warnings in the parallel `warnings` array). There is no `resolvedConfig`/`validationErrors` wrapper. Exit code reflects validation status: `0` when no error-severity `issues`, non-zero otherwise (warnings stay exit-zero in v1.0).
- `--recover` and `--list-recoverable` dispatch to the recovery flow, anchored to the central store. Enumeration reads the repo's runs under `<store-root>/<repo-key>/runs/` (repo-wide, so the same runs are listed from any worktree); `--recover` then binds to the run's recorded `workspace.worktreePath` and refuses from any other worktree. Recovery refuses to touch the module-state store, `.claude/gan/`, or `.gan-cache/` (zone ownership rules).
- `--cleanup` dispatches to the cleanup flow described in the "Cleanup and recovery" section below. Like recovery, it never touches the module-state store, `.claude/gan/`, or `.gan-cache/`.

No sprint work runs in any of these paths.

## Cleanup and recovery

Run *data* lives in the central, repo-keyed store at `GAN_RUN_DIR` (resolved as `<store-root>/<repo-key>/runs/<run-id>/`), and the serialization lock is `<store-root>/<repo-key>/run.lock`. The `<repo-key>` is derived from the repo's main-worktree root, so all linked worktrees of one repo share the same store directory and lock — recovery enumeration and the lock are repo-wide.

**Recovery worktree-anchor (`--recover`).** Enumeration is repo-wide, but *resuming* is bound to the worktree the run executed in. `--recover` reads `progress.json.workspace.worktreePath`; when the current invocation is not that worktree it refuses (non-zero) with `Run <id> was executed in worktree <path> (branch <branch>); recover it from there.` If the recorded worktree no longer exists, recovery refuses with the same path plus guidance to recreate it. The run is still *listed* by `--list-recoverable` from any worktree.

### --cleanup [deferred-to-v1.1]

`[deferred-to-v1.1]` The full destructive cleanup surface — single-run teardown, `--all`, `--all --include-terminal`, the active-run guard, the preview + confirmation prompt, merge-aware run-branch deletion, and the on-disk reclaim — does not ship in v1.0. Invoking `--cleanup` (with any modifier: `--run-id <id>`, `--all`, `--all --include-terminal`, `--yes`, or no modifier at all) in v1.0 prints the structured `this command requires v1.1` message, exits non-zero, and mutates nothing on disk — no central-store run directory is removed, no worktree is touched, no run branch is deleted, no git write occurs. The dispatch handler is inert: it neither no-ops nor partially cleans, and it never reaches the active-run guard or the confirmation prompt. The v1.1 follow-up work wires the already-tested cleanup-planner library as a deterministic tool / CLI, turning the shipped-but-uncallable implementation into the operative path; v1.0 deliberately refuses to ship a behaviour-unverified destructive operation.

### Recovery resume dispatch

After `--recover` passes the preflight (validation, project-root match, worktree-anchor match, run-branch present, clean working tree) and re-attaches the worktree, the orchestrator reads `progress.json.status` and dispatches to one of five re-entry branches. The dispatch is the load-bearing mechanism `--recover` falls through to; there is no shared "resume from sprint N" branch, only these five.

**`[partial-v1.0]` Two safety claims in this subsection are documentation-only in v1.0.** Specifically, the terminal-status reject branch (the preflight refusal for runs whose `progress.json.status ∈ {complete, failed}`) and the `evaluating` branch's malformed-JSON partial-write heuristic ship as prose in v1.0 but have no behaviour code or CI-runnable assertion backing them; each is marked `[deferred-to-v1.1]` inline below. The five status-keyed re-entry branches themselves, the stranded-self-lock guidance, and the `emitTraceEvent` gapless-resume mechanism are operative in v1.0 and back-tested by [tests/skills/skill-recover-resume-dispatch.test.ts](../../tests/skills/skill-recover-resume-dispatch.test.ts) and [tests/config-server/tools/run-lock.test.ts](../../tests/config-server/tools/run-lock.test.ts) respectively. The v1.1 follow-up specs are the natural homes for the deferred code (per-claim deferral notes inline).

- **`[deferred-to-v1.1]` terminal-status preflight reject.** When the user supplies `--run-id <id>` against a run whose recorded `progress.json.status` is `complete` or `failed`, the recover preflight should refuse with a distinct structured error (`reason: 'RunAlreadyTerminal'`) before reaching the dispatch — otherwise the dispatch's five-branch enumeration would fall through on a terminal status and either no-op silently or lexical-match into an in-flight branch and re-run an already-terminal sprint. In v1.0 the default `--run-id` selector still pre-filters to non-terminal runs (per the `--recover` USAGE row above), so the surface is only reachable by explicit `--run-id <terminal-id>`. v1.1 ships this as a recover-preflight subsystem that consults `progress.json.status` before the worktree re-attach and surfaces the `RunAlreadyTerminal` refusal verbatim; it requires a small preflight module wired into the recover entrypoint plus the corresponding behaviour test (the run-enumerator already exposes the `terminal` boolean the check needs).
- **`clarifying`** — the orchestrator re-presents the most recent `clarified-spec.md` (and any sibling `clarified-spec.md.round-N` drafts the round counter wrote on disk) via the same draft-preview action menu the regular clarification phase uses. Round count is preserved across recovery — a halt mid-round-2 resumes at round-2, not round-1; the user picks up where they left off without burning evolution rounds.
- **`planning`** — the orchestrator re-enters the planner stage. If `spec.md` or `plan.md` are absent on disk, the planner runs from `clarified-spec.md` as it would on a fresh run. If both are present (the prior planner attempt landed but recovery happened before the proposer ran), the orchestrator re-emits the planner output to advance the loop into negotiation rather than re-running the planner agent.
- **`negotiating`** — the orchestrator re-enters the contract proposer at the current `progress.json.contractRevision` value and continues any in-flight renegotiation round. This is the same dispatch branch the renegotiation-resume seam rides: a run halted while a re-lock was in flight resumes by reading the canonical `sprint-{N}-contract.json` at its recorded revision (any `sprint-{N}-contract.draft-tmp.<token>.json` partial draft is discarded), and the proposer continues from there.
- **`building`** — the orchestrator reads `sprint-N-base-commit.txt` from the run directory (a run-data artefact under `GAN_RUN_DIR`, with `N` the recorded `currentSprint`), resets the worktree to that commit, and respawns the generator at the recorded `currentSprint` / `currentAttempt`. The base-commit reset is what makes the sprint resumable without double-counting prior partial work; the generator's next attempt builds against the same starting tree the original attempt saw.
- **`evaluating`** — the orchestrator re-spawns the evaluator on the most recent generator-attempt commit (the one whose SHA the trace records for the recorded `currentSprint` / `currentAttempt`). `[deferred-to-v1.1]` If a `sprint-N-feedback-A.json` artefact is present but was being written when the run halted (a partial write detectable by malformed JSON), the orchestrator discards the partial and re-evaluates rather than trusting half-written feedback. The malformed-JSON heuristic is documentation-only in v1.0: `sprint-N-feedback-A.json` is written by the gan-evaluator LLM agent through the generic `Write` tool with no atomicity contract, so the artefact can also halt as a *cleanly-parsing but truncated* prefix that the malformed-JSON check would not flag. Shipping the operative behaviour in v1.1 requires an atomic-write contract on `sprint-N-feedback-A.json` — either a temp-file-then-rename writer routed through `atomicWriteFile` (the framework's universal atomic-write primitive) or a `.completed` sentinel the orchestrator writes after parsing-and-validating the bundle against `evaluator-evidence-bundle-v1.json`; in either case the v1.1 dispatch reads the contract's signal instead of the parses-cleanly fallibility of raw `JSON.parse`.

In every branch the run trace continues writing **gaplessly** via `emitTraceEvent({ runDir, event })`: each call derives the next sequence from `TraceIndex.totalEvents` (reconciled against the authoritative `events/` directory via `reconcileTraceIndex`), so the resumed dispatch's first event takes the next sequence after the trace's last on-disk event. No held emitter is resumed and no separate resume-sequence wiring is required.

**Stranded-self-lock guidance (`--recover` only).** The §"Regular invocation flow" lock-acquisition step refuses a second concurrent run with the structured `ConcurrentRunInProgress` error (`InvariantViolation`, exit 4 = `EXIT_INVARIANT_VIOLATION`) when the on-disk lock at `<store-root>/<repo-key>/run.lock` is held by a *live* `pid` whose `runId` *differs* from the invoking run — the generic concurrent-run refusal. The recovery path distinguishes a second, narrower case: a *live* `pid` whose recorded `runId` **matches** the run the user is trying to recover. Because the lock records the long-lived config-server `pid` (per the lock-lifecycle note in step 7 of "Regular invocation flow"), a run that aborted without releasing — SIGKILL, or the markdown orchestrator skipped the release step — can leave a lock whose pid is *still alive* (the server outlived the run). Auto-breaking such a same-`runId` live-pid lock is unsafe: the matching `runId` cannot, on its own, distinguish an interrupted run from one actively executing in another `/gan --recover` session, so auto-break could clobber a live successor. `--recover` therefore refuses with **stranded-self-lock-specific guidance** (distinct from the generic `ConcurrentRunInProgress` message): the message names the holder's `runId`, `pid`, and `startedAt`, names the **exact lock path** `<store-root>/<repo-key>/run.lock`, and explains that the lock is the same run you are recovering held under a live server pid — either an active session or an interrupted run whose lock was never released. The escape is deliberate manual friction: **if no `/gan` session is running this run, the lock is stale; clear it with `rm <store-root>/<repo-key>/run.lock` and retry.** That is the same `rm <lockpath>` escape the lock-acquisition step documents, now surfaced as a recover-specific message rather than a cryptic different-run refusal. A *dead*-pid lock (regardless of `runId`) is broken silently by the regular lock-acquisition path; the stranded-self-lock case is specifically about a live pid whose `runId` matches the recovery target.

**Forbidden writes during cleanup and recovery** (zone ownership):

- The module-state store — read-only / untouched.
- `.claude/gan/` — read-only.
- `.gan-cache/` — left untouched (regenerable but not run-state).

The orchestrator never writes outside `GAN_RUN_DIR` and `GAN_WORKTREE` during recovery; the v1.0 `--cleanup` stub writes nothing at all.

## Regular invocation flow

The orchestrator follows this order on every regular `/gan` invocation:

1. **Parse args.** Build the flag table from the user's message.
2. **Welcome banner.** Check for `~/.claude/gan/welcomed`. If absent, the user did not pass `--skip-welcome`, and stdin/stdout are TTY, render the welcome banner described in the "Welcome banner" section above. After the banner finishes printing, create the marker (`mkdir -p ~/.claude/gan && touch ~/.claude/gan/welcomed`). On non-TTY invocations the marker is created without rendering the banner. With `--skip-welcome`, the marker is created without rendering the banner regardless of TTY status. If the marker already exists, this step is a no-op.
3. **`validateAll()` (aborting).** Failure aborts the run with the framework's structured error report — no worktree is created, no agent is spawned, and no zone-2 or zone-3 writes occur. The structured error fields (`code`, `file`, `field`, `line`, `message`) are surfaced verbatim. The user-facing remediation hint (when present) is forwarded as-is; the orchestrator does not paraphrase or interpret API errors.
4. **`NoPromptProvided` check.** If the invocation carries no prompt and no agent-spawn-short-circuiting flag (not `--help`, `--print-config`, `--list-recoverable`, or `--recover`), halt here with the structured error `NoPromptProvided` and the exact user-facing message reproduced in the "Bare invocation" section above. This check runs **after** `validateAll()` (step 3) and **after** the welcome banner (step 2), but **before** the clarifier and **before any run-lockfile is acquired or any run state is created** — a bare invocation never creates run state. (See "Bare invocation" above.)
5. **`getResolvedConfig()` — capture the snapshot once.** The returned snapshot is the **single source of truth** for this run. It is data, not configuration. The orchestrator passes it to every spawned agent.

   **Enrich the snapshot with active-stack bodies before spawn.** The `ResolvedConfig` carries only metadata for each active stack — `{tier, path, schemaVersion}` — not the body fields the agents reference (`buildCmd`, `testCmd`, `lintCmd`, `auditCmd`, `secretsGlob`, `securitySurfaces`, `cacheEnv`, `scope`). After `getResolvedConfig()` returns, for each name in `snapshot.stacks.active`, call the API's `getStack(name)` to load the parsed body and attach those fields onto the matching `snapshot.stacks.byName[name]` entry. The result is the "enriched snapshot" — what every agent prompt means by `snapshot.activeStacks[*].buildCmd` etc. Re-enrichment is performed only when the snapshot is re-captured after a `mutated: true` API call (per the freshness rule below); idempotent re-runs against an unchanged snapshot reuse the enriched object.
6. **Print the startup log.** One structured record summarising the active stacks (with their resolution tier), overlay sources (with a `(loaded)` marker per file), additionalContext paths, and discarded fields read verbatim from the snapshot's `discarded` `string[]`. Missing sources are listed explicitly as `(none)`; nothing is silently omitted. The block follows this exact shape:

   ```
   /gan loaded:
     stacks: web-node (project)
     user overlay: ~/.claude/gan/user.md  (loaded)
     project overlay: .claude/gan/project.md  (loaded)
     additionalContext: docs/architecture.md, docs/conventions.md
     discarded: proposer.additionalCriteria, generator.additionalRules
   ```

   The `discarded` line is the snapshot's `discarded` array verbatim — dotted `block.field` names where some tier set `discardInherited: true`. It does not carry per-tier origin or replacement detail (the data layer collapses that to a boolean); the replacement value, when present, is visible under the snapshot's `overlay.<field>`.

   **First-run nudge.** When the active stack set resolves to `stacks/generic.md` only (no real ecosystem stack matched), the startup log emits an additional non-suppressible line, verbatim: `No recognised ecosystem stack — running with generic defaults. For richer behaviour, run \`gan stacks new <name>\` to scaffold a stack file, or fork an existing one from \`stacks/\` as a starting point.` The note appears even when log verbosity is reduced.

   **Overlay-misuse warnings.** After the startup log line, the orchestrator emits one additional stderr line per warning attached to the captured snapshot's `warnings` array. The snapshot is the single source of truth: the orchestrator reads each warning's already-computed `code` and `message` and never recomputes the detection — the framework decided during snapshot capture which warnings apply. Iterate `snapshot.warnings` in array order and emit, for each, exactly one line of the form:

   ```
   warning: <code>: <message>
   ```

   where `<code>` is the warning's machine code (e.g. `StackOverrideShrinkage`) and `<message>` is the warning's prose, both read verbatim from the warning. A snapshot carrying N warnings yields exactly N such lines; a snapshot with an empty `warnings` array emits none. Like the first-run nudge, these lines are **non-suppressible**: reduced log verbosity and any verbosity flag do not silence them, and v1.0 ships no per-warning suppression switch. A user silences a warning only by correcting the overlay it flags (for example, listing every detected stack in `stack.override`, or removing a per-stack command override) — never by a flag.

7. **Resolve the run store and acquire the run lock.** Call `resolveRunStore` (no arguments) to mint a fresh `<run-id>` and resolve every store path — `runDir` (the central-store `GAN_RUN_DIR`), `repoKey`, `runLockPath`, and `mainWorktreeRoot` (the repo root the run's worktree is created under; threaded into step 9 to save a second git read). This step writes nothing. Then call `acquireRunLock({ repoKey, runId })`. **The lock must be held before the *first* zone-2 write** — which is the clarifier's `clarified-spec.md` / `raw-prompt.md` at step 8, *not* merely before the worktree is created at step 9 — so a second concurrent `/gan` is refused with `ConcurrentRunInProgress` before it can burn the interactive clarification phase. On a live-holder refusal the orchestrator surfaces the structured error verbatim and exits without further work. Because the recorded pid is the long-lived config server, an unreleased lock is *never* self-healed as stale, so release on every exit path is mandatory (see step 11 and the abort/error notes below).
8. **Clarification phase.** Unless `--skip-clarification` was passed, spawn `gan-clarifier` with the user prompt, the captured snapshot, the union of every per-agent `additionalContext`, and the bounded directory listing obtained from the framework's `getBoundedDirectoryListing` read tool (it unions the active stacks' scope globs and returns a scope-filtered, ignore-pruned, structure-only listing). The clarifier writes `clarified-spec.md` under `GAN_RUN_DIR` and the orchestrator preserves the verbatim original prompt alongside it as `raw-prompt.md`. The orchestrator then renders the draft preview and resolves the user's action (see "Clarification phase" below). The approved `clarified-spec.md` is the planner's primary input — and the proposer reads it for criteria derivation. With `--skip-clarification`, the orchestrator (not the clarifier) writes the minimal `clarified-spec.md` itself and proceeds. This phase runs after the snapshot is captured, the startup log is printed, and the run lock is held; the worktree and sprint loop come next.
9. **Create the worktree.** Call `createRunWorkspace({ subject, runId, mainWorktreeRoot })`, threading the `mainWorktreeRoot` that step 7's `resolveRunStore` already returned so the tool reuses it instead of re-running `git rev-parse --git-common-dir` a second time (the field is optional — omitting it falls back to an internal re-derivation). Wraps the framework's `resolveWorkspace` (`src/config-server/storage/worktree-resolver.ts`, cases 1a / 1b / 1c). Act on the returned `{ worktreePath, branch, createdByGan, resolutionCase, mutated }` (`mutated` equals `createdByGan` — `true` for 1b/1c, `false` for 1a; it is the worktree-creation mutation signal and does not feed the snapshot-freshness re-snapshot rule, which is scoped to agents' configuration writes):
   - `resolutionCase: '1a'` (`createdByGan: false`) — the run is already inside a dedicated non-main worktree whose branch matches the subject; reuse it in place, do not create a second worktree, and do not touch the branch on cleanup.
   - `resolutionCase: '1b'` (`createdByGan: true`) — the matching branch was on the main checkout; the framework moved it into a fresh run-scoped worktree under `<GAN_WORKTREE>` (project-local `.gan-state/runs/<run-id>/worktree`).
   - `resolutionCase: '1c'` (`createdByGan: true`) — no matching branch; the framework created a brand-new branch and a fresh run-scoped worktree under `<GAN_WORKTREE>`.
   A run started in the main checkout or on a non-matching branch therefore deterministically gets a fresh 1b/1c worktree and never executes in place; only a dedicated non-main worktree is reused (1a). Record run metadata in `progress.json` under `GAN_RUN_DIR`; the `<run-id>` follows the established `<YYYYMMDDTHHMMSS>-<4 hex>` form.
10. **Spawn the sprint loop.** For each sprint:
   - The planner reads `clarified-spec.md` (the clarifier's output, under `GAN_RUN_DIR`) as its **primary input** for the spec and plan it produces.
   - Pass the snapshot to `gan-contract-proposer` (proposes the sprint contract — every security criterion sourced from the active stacks' `securitySurfaces` via the proposer's template-instantiation protocol; the proposer reads `clarified-spec.md` to derive contract criteria).
   - Pass the snapshot and the contract to `gan-generator`.
   - Pass the snapshot, the contract, and the worktree state to `gan-evaluator`. The evaluator's input is **unchanged** — it reads only the contract, never the clarified spec.

   The orchestrator never re-parses configuration files between sprints; it always passes the captured snapshot.

   **No between-sprint prompt.** The loop runs fully autonomously: the orchestrator advances from each sprint to the next without pausing, and never asks the user to choose between autonomous and per-sprint-pause execution.

   **Before each attempt of any role** (including the single-attempt clarifier and planner), the orchestrator runs the three triggers described under "Safety halts — shared contract": the per-role ceiling check (for multi-attempt roles), the sprint-wide budget check (for every role), and — before each generator attempt specifically — the edit-oscillation check. If any check halts, the orchestrator does not spawn the next attempt; it halts the sprint per the halt contract. Only when no check halts does it proceed to the spawn.

11. **Tear down and release the lock.** On **every** run-exit path — graceful completion, abort (user cancel, `validateAll` failure after the lock is held, `ConcurrentRunInProgress` is the one exception: nothing was acquired), or error (uncaught failure, loop-detection halt, recovery refusal) — the orchestrator marks the run terminal in `progress.json` (under `GAN_RUN_DIR`), removes the worktree filesystem (the run branch survives for inspection), and **then calls `releaseRunLock({ repoKey, runId })`**. The release is the last write the orchestrator performs for the run. Release-on-exit cannot be deferred: the acquiring process is the long-lived config server, so a lock left held by it would never be self-healed as stale, and the next `/gan` on the same repo would be refused indefinitely. Release is idempotent — a double-release on an overlapping graceful-then-error path is safe. The `runId` argument is the acquiring run's id (already in hand from `resolveRunStore` at step 7, and exported as `GAN_RUN_ID` to every sub-agent); the tool reads the on-disk lock's contents and unlinks only when the recorded holder's `runId` matches, so a late, stale tear-down from a superseded run is a silent no-op and never deletes a live successor's lock.

## Snapshot freshness rule

The captured snapshot is **frozen across user-side edits** for the entire run, including across multiple sprints in a multi-sprint plan. Wall-clock time between sprints does not matter; user edits to overlay or stack files mid-run are not picked up until the next `/gan` invocation.

When any agent's API call returns `{ mutated: true, ... }` (the framework's mutation indicator), the orchestrator records the per-sprint OR of every agent's `mutated` flag; if any agent in the prior sprint produced `mutated: true`, the orchestrator **always** re-snapshots via `getResolvedConfig()` before spawning the next agent. Re-snapshot-after-true-mutation is unconditional. A `mutated: false` result (e.g. duplicate-skip append) does **not** trigger a re-snapshot.

## Safety halts — shared contract

The framework runs three independent triggers that can halt a sprint mid-loop: a per-role attempt ceiling, a sprint-wide attempt budget, and an edit-oscillation detector. They share one halt contract and differ only in the per-trigger distinctions below.

**Timing.** Every trigger is evaluated at attempt-start boundaries — immediately before the orchestrator would spawn the next attempt. An attempt already in flight runs to completion; no trigger cancels work mid-attempt. All triggers that apply at a given boundary are evaluated together; if any says halt, the orchestrator halts.

**Mechanism — the trace is the only counter.** No trigger maintains its own counter file. The orchestrator reconstructs the per-role attempt counts (and, for oscillation, the generator's per-attempt edit-fingerprint history with post-rejection flags) from the run's `agentAttempt` events via `reconstructRecoveryState`, then feeds that state into the appropriate pure decision helper (`checkRoleCeiling`, `checkSprintBudget`, `detectEditOscillation`).

**Effective safety config — resolved once, then fed to every check.** At run start the orchestrator resolves the *effective* safety config (seed defaults; the merged overlay's `safety.*` block including `safety.attemptCeilings.<role>`, `safety.sprintBudget`, and `safety.oscillationDetection`; and the one-off runtime flags) with the framework's pure effective-safety-config resolver. Precedence is **flags > overlay > defaults**. The resolved values feed every check; the seed defaults are never consulted directly. `--max-attempts=<n>` is the coarse one-off override: it applies a uniform per-role ceiling of `n` to every multi-attempt role and derives the sprint budget as `n × roleCount + 4` (the `+4` covers the clarifier, planner, reviewer, and evaluator). An overlay raising one role's ceiling leaves the other roles at their seed defaults — an unspecified role is never dropped.

**On a halt.** Whichever trigger fires, the orchestrator:

1. Builds a `safetyHalt` trace event with `buildLoopDetectedBody` (the body carries `safetyClass = "loopDetected"` plus the trigger-specific `role` and payload) and emits it via `emitTraceEvent({ runDir, event })` (which calls `appendTraceEvent(runDir, event)` under the hood — stateless, one event per call).
2. Surfaces a `LoopDetected` structured error built by the trigger's error builder (see below). Every error renders user-facing prose that points at the run's trace directory under the central store and tells the user to re-run with `--recover`.
3. Marks the sprint halted and exits with the framework's `LoopDetected` exit code — one code shared by all three triggers, distinct from the validation/contract exit codes.

A halted sprint is recoverable via `--recover`. Unless the user changes the prompt (or raises the relevant ceiling/budget/flag), the next attempt halts again on the same condition.

**Terminal-reason and recovery.** When a halt fires, the orchestrator marks the run terminal with `terminalReason: "failed-loop-detected"` (the kebab-case loop-halt reason) so `--recover` can find and resume it. On `--recover`, the framework reconstructs counters from `agentAttempt` events via `reconstructRecoveryState` and derives the starting state from that reconstruction:

- **Without `--reset-attempts` (the default), the reconstructed counters are preserved.** A recovered sprint already at its ceiling therefore halts again on the very next attempt-start check; the user must change the prompt (or raise the ceiling/overlay) for the next attempt to converge differently.
- **With `--reset-attempts`, the recovered sprint resumes with attempt counters at zero,** behaving like a fresh sprint that does not immediately halt.
- **`--reset-attempts` is valid only alongside `--recover`.** Passing it standalone is rejected with a structured usage error.

### Trigger 1 — Per-role attempt ceiling

- **Roles checked.** Multi-attempt roles only: `gan-contract-proposer` and `gan-generator` (seed default ceiling 3 each). The single-attempt clarifier and planner and the once-per-output reviewer and evaluator are never checked here.
- **Counter substrate.** Per-role attempt counts reconstructed from `agentAttempt` events.
- **Trigger logic.** Halts when `attempts ≥ effective ceiling` for the multi-attempt role about to be spawned.
- **Error builder.** `createLoopDetectedError` — `reason` and `role` identify the per-role halt (the role name and its attempt count/ceiling). The message names the role, its count and ceiling, points at the trace directory, and tells the user to adjust the prompt or raise the ceiling and re-run with `--recover`.
- **Gating.** Always runs.

### Trigger 2 — Sprint-wide attempt budget

- **Roles checked.** Every role — including the single-attempt clarifier and planner and the once-per-output reviewer and evaluator. Every role's attempts count toward the sprint-wide total even though no per-role ceiling applies to them.
- **Counter substrate.** The summed per-role attempt counts reconstructed from `agentAttempt` events (the same accounting the per-role check uses).
- **Trigger logic.** Halts when summed attempts ≥ the effective budget. The effective budget is `overlay safety.sprintBudget`, else the `--max-attempts`-derived `n × roleCount + 4` when `--max-attempts` was passed, else the seed default 12 (the sum of the seed per-role ceilings — proposer 3 + generator 3 — plus headroom for the four roles that carry no per-role ceiling).
- **Error builder.** `createSprintBudgetError` — same `LoopDetected` error code, with `reason = "sprintBudgetExceeded"` and the synthetic `role = "sprint"`. The synthetic role denotes the aggregate budget; it is not itself a multi-attempt role and is never per-role-ceiling-checked. The message names the combined attempt count and the budget, points at the trace directory, and tells the user to adjust the prompt or raise the budget and re-run with `--recover`.
- **Gating.** Always runs.

### Trigger 3 — Edit-oscillation detection

- **Roles checked.** The generator role only.
- **Counter substrate.** The generator's per-attempt edit-fingerprint history, paired with a post-rejection flag per attempt. Both come from the trace: the fingerprints from the edit sets recorded per attempt (normalized so that whitespace-only, comment-only, and reordering-only differences collapse to the same fingerprint), and the post-rejection flag reconstructed from the rejection the evaluator recorded before the attempt. The pure detector compares attempts by the fingerprint value the fingerprinting layer already produced; it does not re-derive its own fingerprint.
- **Trigger logic.** Two independent sub-triggers, either of which halts on its own:
  - **Direct-repeat-on-second** — the same fingerprint recurs a third time across the history (the *second* repeat). The halt waits for the second repeat because a single isolated repeat could be an instructed revert.
  - **3-cycle** — an attempt's fingerprint equals the one from two attempts earlier (an A → B → A alternation), catching a generator swinging between two interpretations even when no two adjacent attempts repeat.
  - **Post-rejection guard.** A repeat is only counted toward either sub-trigger when the repeating attempt followed an evaluator rejection. An otherwise-matching repeat that did not follow a rejection does not halt — a generator reverting a partial edit because the evaluator instructed it to ("undo that") is doing instructed work, not oscillating.
- **Error builder.** `createEditOscillationError` — same `LoopDetected` error code, with `reason = "editOscillation"` and `role = "gan-generator"`. The `safetyHalt` event's payload evidence is `{ fingerprintSequence, detectedPattern }`. The message names the attempt count and whether the generator repeated one edit or alternated between two, points at the trace directory, and tells the user to adjust the prompt and re-run with `--recover`.
- **Gating.** Gated by the resolved effective-safety config's `oscillationDetection` boolean (overlay `safety.oscillationDetection`, else default `true`). When `true`, the orchestrator consults the detector. When `false`, the orchestrator skips the check entirely and a generator that repeats fingerprints proceeds up to its per-role ceiling without an `editOscillation` halt; only ceiling and budget apply. The gate is on the call site (whether the orchestrator consults the detector), not on the detector itself.

## Per-run state versus configuration

Per-run state — `progress.json`, sprint contracts, evaluator feedback, generator artefacts — lives directly under `GAN_RUN_DIR` (the central-store run directory, zone 2). It is **not** Configuration API territory. The API is for framework configuration; per-run state is for sprint orchestration.

The orchestrator is the sole writer of `progress.json`. Sub-agents may read it but never write it; they communicate state transitions via stdout status lines that the orchestrator parses.

## Error surfacing

Every API error (during validation or during a sprint) is reported with the structured fields preserved verbatim: `code`, `file`, `field`, `line`, `message`. The orchestrator does not interpret, translate, or summarise these. User-facing messages obey the framework's error-text discipline: shell remediation (`rm <path>`), references to "the framework" rather than specific runtimes, no maintainer-only script names, readable to a developer who has only run `install.sh`.

## Confinement

The framework-owned PreToolUse confinement hook remains in place. Spawned agents write only inside the resolved worktree and to their designated artefact paths under the run directory. MCP tool calls are not file-system reads; agents may call the API freely from inside a confined worktree.

Before spawning agents at sprint start, the orchestrator exports three absolute-path environment variables that the confinement hook reads to derive its two allowed zones:

- `GAN_RUN_ID` — the active run's identifier (`<YYYYMMDDTHHMMSS>-<4 hex>`). When unset, the hook is a no-op: confinement is a per-sprint constraint, not global.
- `GAN_WORKTREE` — the resolved worktree. This is the user's own worktree when the run reuses a task-named worktree, or the run-scoped worktree the framework created otherwise. Writes anywhere under it are in-bounds.
- `GAN_RUN_DIR` — the central-store run directory that holds the run's artefacts, its `trace/` subtree, and its `telemetry/` subtree. Only the declared artefact subpaths under it are in-bounds.

The hook derives its zones from `GAN_WORKTREE` and `GAN_RUN_DIR`. It stays a pure deny-gate: it allows writes inside those two zones and denies everything else (`~/.claude/`, the home directory generally, the module-state directory, the ephemeral cache, and any path outside both zones). `gan hooks status` reports the resolved `GAN_WORKTREE` and `GAN_RUN_DIR` for the active run, or notes that the command is running outside a run.

## Trust integration

When the validation step returns the `UntrustedOverlay` structured error, the orchestrator surfaces the interactive trust prompt **before reaching any command-execution path**. The prompt is a protocol the orchestrator is contracted to obey, not a server-enforced gate: the orchestrator MUST show what the approval covers (the changed or newly-declared command-bearing fields, plus the disclosure that the trust hash does not cover the scripts those commands invoke), wait for explicit consent, and call `trustApprove` **only** when the user chooses `[a]`.

The rendered prompt text and the full `[v]` / `[a]` / `[r]` / `[c]` option set are the single responsibility of [`trust-prompt.md`](trust-prompt.md); the orchestrator renders the first-introduction or config-changed variant per whether `getTrustState(projectRoot)` reports a prior approval, and does not restate the options here.

`GAN_TRUST=strict` makes the prompt fail closed in CI; `GAN_TRUST=unsafe-trust-all` skips the trust check entirely (logged loudly).

## Clarification phase

After the snapshot is captured and the startup log is printed, and before the worktree and sprint loop, the orchestrator runs the clarification phase. Unless `--skip-clarification` was passed, it spawns `gan-clarifier` with the user prompt, the snapshot, the union of every per-agent `additionalContext`, and a bounded directory listing obtained from the framework's `getBoundedDirectoryListing` read tool — which unions the active stacks' scope globs and returns a structure-only listing, scope-filtered and pruned of paths the project's own ignore file excludes. The clarifier writes `clarified-spec.md` under the run's state directory; the orchestrator preserves the verbatim original prompt alongside it as `raw-prompt.md`. The approved `clarified-spec.md` is the planner's primary input.

**Draft preview + action menu.** After the clarifier produces `clarified-spec.md`, the orchestrator renders the full document to the terminal — its `Goal`, `In scope`, `Out of scope`, `Assumptions`, `User actions`, and `Constraints` sections — and below it presents the action menu:

```
Proceed with this spec? [a]pprove / [e]dit / "evolve: <text>" / [c]ancel
(auto-approve in 60s)
```

`[a]`, `[e]`, and `[c]` are **single keystrokes, case-insensitive**. `evolve:` is a **literal, case-insensitive prefix** followed by the evolution text. Matching is **exact** — the orchestrator never silently accepts a paraphrase or synonym. A free-text response that matches none of these falls through to the partial-answer rule: it is parsed per-blocker, any unanswered blockers fall through to assumptions, and the draft is regenerated and re-presented (counting as one round).

- **`[a]` approve** — proceed with the current draft to the planner.
- **`[e]` edit** — open the draft in the editor (see "Editor flow" below); editing does **not** consume an evolution round.
- **`evolve: <text>` evolve** — re-run the clarifier with added context (see "Evolution rounds" below); consumes one round.
- **`[c]` cancel** — abort the run (see "Signal handling" below).

**Timeout.** The orchestrator waits for input with a default 60-second timeout, resolved from the `clarifier.draftTimeoutSeconds` overlay splice (default `60`). `--clarifier-timeout=<seconds>` overrides it for one run; both paths enforce the `[10, 600]` range, and an out-of-range value (and `0`) is rejected with the structured error `InvalidTimeoutValue` before any agent fires. On timeout with no input, the orchestrator **auto-approves the current draft** and proceeds to the planner; the clarified spec records the auto-approval explicitly (an `autoApprovedOnTimeout` user action noting the draft was auto-approved on timeout).

**Evolution rounds.** A run allows **up to three rounds total** — the initial round plus at most two evolutions. An `evolve: <text>` response re-runs the clarifier with the **original prompt + the accumulated `additionalContext` + the user's evolution text**, producing a fresh `clarified-spec.md` presented via the same draft-preview surface; this counts as one round. The orchestrator preserves each prior-round draft at `clarified-spec.md.round-N` (where `N` is the round number); `raw-prompt.md` stays the verbatim original — history is never rewritten. Reaching the **third round forces the user to choose approve / edit / cancel**; further evolution attempts are rejected. If a regenerated draft fails schema validation, the orchestrator surfaces the structured error inline, keeps the prior round's draft authoritative, re-presents the action menu against that prior draft, and the failed regeneration still **counts as one round**.

**Editor flow (`[e]dit`).** The orchestrator resolves the editor command via the chain `$EDITOR` → `$VISUAL` → `vi`. If none resolves to an executable on `$PATH`, it halts with the structured error `EditorNotConfigured`, naming all three checked variables and telling the user to set one. It spawns the editor on `clarified-spec.md` and imposes **no sub-timeout** on the editor. On editor exit it **re-validates** the edited `clarified-spec.md` against the same document schema `validateAll()` uses; on validation failure it shows the structured error inline and re-opens the editor on the same file; on success it re-renders the edited draft and re-prompts the action menu. The editor flow does **not** consume an evolution round (only `evolve: <text>` does). Ctrl-C **inside the editor** is treated as "abandon edit; re-render the previous draft and re-prompt the action menu" — it does not cancel the run.

**Signal handling.** Ctrl-C **at the action menu** is treated identically to typing `[c]ancel`: the run halts with the structured error `UserCancelled` and the orchestrator writes the kebab-case terminal reason `aborted-by-user` to `progress.json` (`progress.json.terminalReason`). Run state is preserved, so `--recover` can resume from the same draft. This is distinct from Ctrl-C inside the editor, which abandons the edit rather than cancelling the run.

**`--skip-clarification`.** This flag bypasses the clarifier entirely. The **orchestrator** (not the clarifier — it is bypassed) writes the minimal `clarified-spec.md`: `Goal` = the verbatim user prompt; `In scope`, `Out of scope`, and `User actions` empty; `Assumptions` a single entry stating the user invoked `--skip-clarification` and downstream agents proceed with the raw prompt as goal; `Constraints` derived from `additionalContext` and the active stacks. `raw-prompt.md` is preserved alongside. The flag does **not** short-circuit `validateAll()` — clarification happens after validation in the pipeline — and the run proceeds straight to the planner with this minimal spec.

**No-ambiguity case.** When the clarifier produces a `clarified-spec.md` with **zero blockers and no assumptions worth recording**, the orchestrator does **not** present the draft preview or action menu — it proceeds directly to the planner. The clarifier's attempt is still recorded in the audit trail.

**Trace.** The clarifier emits `agentAttempt`, `llmCall`, `clarifierFinding`, and `clarifierUserAction` events per round, and a `safetyHalt` of class `clarifierCancelled` when the user cancels at the action menu.

## Run-trace integration points

Every `/gan` run writes a structured, append-only event log to `<GAN_RUN_DIR>/trace/` via the framework's trace library: at each milestone, agent attempt, LLM call, and tool call (`orchestratorMilestone`, `agentAttempt`, `llmCall`, `toolCall`), the orchestrator emits a typed event by calling `emitTraceEvent({ runDir, event })` (the MCP tool, which delegates to the shared `appendTraceEvent(runDir, event)` library function). Each call is stateless and exclusive-create — one event per call, no held emitter object. The trace is the read-substrate for loop detection, recovery, and later cost/accuracy phases. The trace lives entirely on the local filesystem and is never transmitted off-machine.

The orchestrator/skill runtime wires the following integration points. Each names the framework helper or formatter it calls.

- **Agent-attempt heartbeat (stderr).** Before an agent's **first** LLM call in an attempt, the orchestrator emits one heartbeat line to stderr. The line is produced by the `formatHeartbeat(role)` formatter and renders exactly `[<role>] thinking...` — metadata only, no payload content. Emitted once per attempt.

- **Per-LLM-call and sprint-end summaries (stderr).** When each LLM call completes, the orchestrator emits the one-line cost/latency summary produced by `formatLlmCallSummary` (reading the `llmCall` event's metric fields). At every sprint termination — graceful completion, loop-detection halt, validation abort, user cancel, or error — it emits the cumulative line produced by `formatSprintSummary` / `formatSprintSummaryFromEvents`, aggregated from the trace. These lines go unconditionally to stderr and carry operational metadata only (token counts, latency, cache-hit status, counts and sums); never prompt or response content, and no dollar cost.

- **Trust-prompt resolution → `trustEvent`.** When the interactive trust prompt resolves (the `[v]` / `[a]` / `[r]` / `[c]` path owned by [`trust-prompt.md`](trust-prompt.md)), the orchestrator records the outcome by building a `trustEvent` with the `buildTrustEventBody` builder and emitting it via `emitTraceEvent`. The builder maps the resolution's `promptVariant` and the user's `userChoice` faithfully — in particular, `[a]`/`approve` and `[r]`/`runWithoutProjectCommands` are distinct outcomes and are never collapsed.

- **`validateAll()` abort → `validationAbort`.** When `validateAll()` (aborting mode) fails and aborts the run, the orchestrator builds a `validationAbort` event with the `buildValidationAbortBody` builder and emits it via `emitTraceEvent` before exiting. The builder copies the framework's structured-error payload (`code`, `message`, and any `file` / `field` / `line`) into the event **verbatim**, so the validation diagnostic in the trace matches the structured error the user is shown field-for-field.

- **`--recover` → trace-driven resumption.** Recovery reads the archived trace (the archive includes the entire trace directory) to reconstruct sprint state with the `reconstructRecoveryState` helper: it reconstructs the per-role attempt-counter state purely from the `agentAttempt` events — **without** any external counter file. Resumption then continues writing to the same trace directory by calling `emitTraceEvent({ runDir, event })` (or `appendTraceEvent(runDir, event)`) for each new event: each call derives the next sequence from `TraceIndex.totalEvents` (reconciled against the authoritative `events/` directory via `reconcileTraceIndex` on retry), so the next call writes the next sequence **gaplessly** — no held emitter is resumed and no resume-sequence plumbing is required. A run halted by the safety layer carries `terminalReason: "failed-loop-detected"`, which is what makes the loop halt discoverable to recovery. Without `--reset-attempts` the reconstructed counters are preserved (so a recovered sprint at its ceiling halts again on the next attempt); `--reset-attempts` — valid only alongside `--recover` — instead resumes with counters at zero. See "Safety halts — shared contract" → "Terminal-reason and recovery".

- **Loop-detection `safetyHalt`.** The trace reserves the `safetyHalt` event class (a reserved extension point with a `safetyClass` discriminator); the framework's loop-detection layer emits a `safetyHalt` with `safetyClass = "loopDetected"` when it halts a run. The orchestrator builds that event body with the `buildLoopDetectedBody` helper and emits it via `emitTraceEvent({ runDir, event })` at the moment of the halt — the same builder for every loop-detection trigger. The **per-role ceiling** decision is the `checkRoleCeiling` tool; the **sprint-wide budget** decision is the `checkSprintBudget` tool; the **edit-oscillation** decision (for the generator role) is the `detectEditOscillation` tool. All three are fed state reconstructed from the trace by `reconstructRecoveryState` — the ceiling/budget checks the per-role attempt accounting (the same counters recovery uses), and the oscillation check the generator's per-attempt fingerprint history with post-rejection flags — so there is no separate counter or fingerprint file. When any check returns a halt, the orchestrator surfaces the `LoopDetected` structured error (built with `createLoopDetectedError` for a per-role halt, `createSprintBudgetError` for a budget halt, or `createEditOscillationError` for an oscillation halt; all render user-facing prose pointing at the run's trace directory and `--recover`, and all use the single `LoopDetected` exit code). See "Safety halts — shared contract" for the timing and the per-trigger distinctions.

- **Evaluator forced-plan derivation.** Before the evaluator scores a sprint, the orchestrator calls `buildEvaluatorPlan` to derive the deterministic verification plan from the sprint contract and active-stack `buildCmd` / `testCmd` / `lintCmd` / `auditCmd`. The tool returns data only — it executes nothing — and the evaluator runs the plan under the trust ladder.

## Renegotiation loop [shipped-in-v1.0]

After a generator attempt commits, the orchestrator runs the renegotiation loop before the evaluator scores. The loop has six steps in this exact order:

1. **Generator commits its attempt.** The generator runs to completion against the current locked contract revision and commits its diff. No renegotiation work begins until the generator's attempt is on disk.
2. **Independent reviewer runs over the diff.** The orchestrator spawns the reviewer role on the generator's diff. The reviewer writes its bundle to `sprint-{N}-independent-review-{attempt}.json` under the run directory (`{N}` the sprint index, `{attempt}` the generator's attempt letter — `A`, `B`, …). The bundle carries `findings[]` (each with `kind`, `severity`, evidence, and a `suggestedCriterion`), a per-severity `summary`, and the `contractRevision` it was authored against.
3. **Finding validation runs two guards by kind.** Command-reproducible findings (`kind: "command"`) carry a `reproductionCommand`; the orchestrator invokes the `validateFindings` MCP tool, which re-runs each command under a safe-by-default `/bin/sh -c` runner (the schema's metacharacter `pattern` plus the gate's defence-in-depth `UNSAFE_COMMAND_CHARACTERS` regex have already refused chaining/substitution/redirection/newline/NUL/backslash before the runner ever fires). The tool drops with `reproduction-failed` on a non-zero exit, `reproduction-unsafe` when a banned character slipped past the schema, and `reproduction-errored` when the runner throws — a finding the reviewer believed in but cannot be reproduced does not advance. Inspection findings (`kind: "inspection"`) carry an `evidencePointer` and are passed through unchanged; they are flagged for the contract-reviewer's well-foundedness audit (which lands in a later sprint and is deliberately out of scope here) rather than being auto-dropped. Findings that carry neither a reproducible command nor an evidence pointer are routed to the advisory tier (step 4 ignores them).
4. **Renegotiation round if any surviving blocker/warning maps to no existing criterion.** The orchestrator scans the surviving `blocker` and `warning` findings against the criteria already in the current locked contract revision. If every such finding is covered, the round is skipped and the orchestrator proceeds to step 6 against the current revision. Otherwise the proposer is spawned with the uncovered findings and adds new criteria for them; the contract-reviewer audits the additions for well-foundedness; the result is a new draft contract.
5. **Re-lock at a new contract revision.** The orchestrator writes the audited draft to a `.draft-tmp.<token>.json` path under the run directory, then invokes the `relockContract` MCP tool with that path. The tool archives the prior canonical contract as a `.r{k}.json` sibling and atomically swaps the new draft onto the canonical filename, then read-modify-writes `progress.json` (status `"negotiating"` → `"building"`, contractRevision incremented by one). The new revision becomes the authoritative contract for every downstream step in this attempt; the prior revisions remain on disk as operator-readable history. See the section below for the lifecycle and crash semantics.
6. **Evaluator scores the current revision.** The evaluator reads only the (now possibly re-locked) canonical contract — the same join key it has always used — and is the sole gate on whether the attempt passes the sprint. The reviewer's bundle and the dropped-finding ledger do not gate; they inform.

**Advisory findings never trigger renegotiation.** A finding whose post-validation severity is `advisory` (either authored that way by the reviewer or downgraded by the well-foundedness audit) is recorded for the audit trail and either rolls into the next attempt's reviewer-input context or becomes a follow-up task. It does not add a criterion, does not start a renegotiation round, and never delays the evaluator. Only surviving `blocker` and `warning` findings that map to no existing criterion drive step 4.

**Cap hit with unresolved blockers — `terminalReason: "failed-evaluation-rejected"`.** A renegotiation cap bounds the number of rounds permitted in a single sprint. When the cap fires while at least one `blocker`-severity finding remains unresolved, the orchestrator invokes the `writeFailedEvaluationRejected` MCP tool, which marks the run terminal with `terminalReason: "failed-evaluation-rejected"` (literal kebab-case) on `progress.json` and writes `terminal: true` alongside it (the tool is a no-op if the cap has not fired or no blockers remain — both guards belt-and-brace the irreversible terminal write). This terminal class is a *rejection* — the gate said no, and the run records that the work was not accepted — and is deliberately distinct from the `LoopDetected` terminal reasons recorded by the loop-detection layer. `LoopDetected` (with `terminalReason: "failed-loop-detected"`) signals genuine non-convergence detected by the per-role ceiling, the sprint-wide budget, or the edit-oscillation detector, and recovery is about adjusting the prompt or raising a ceiling; `failed-evaluation-rejected` signals that the renegotiation cap was reached with at least one unresolved blocking finding, and recovery is about resolving that flagged defect. Treating the two outcomes as separate terminal reasons (rather than laundering a cap-with-blockers exit into a thrash-halt) preserves the distinction a user needs to act on it.

## Contract lifecycle under renegotiation (re-lock, not mutate) [shipped-in-v1.0]

Renegotiation re-locks the contract at a new revision rather than mutating the existing locked file in place. The lifecycle has four invariants:

- **Canonical filename stays `sprint-{N}-contract.json`.** Downstream consumers — the evaluator's evidence-bundle join in particular — read this exact filename to find the currently-authoritative criteria. The canonical filename is never renamed and never gains a revision suffix; the join key the framework already ships is hardcoded against the unsuffixed name.
- **Prior revisions are archived as siblings `sprint-{N}-contract.r{k}.json`.** `k` is the revision index the archived file was authoritative under: `k = 0` for the original locked contract (so the first renegotiation produces `sprint-{N}-contract.r0.json` holding the original revision), `k = 1` for the next, and so on. Archived siblings are operator-readable history; they are not new join targets for any downstream consumer.
- **Each round writes a fresh draft, audits it, then atomically replaces the canonical file** by first archiving the superseded canonical (rename it to its `.r{k}.json` sibling) and then renaming the audited draft onto the canonical filename. The atomic-replace sequence — archive-then-swap, using the POSIX `fs.rename` primitive — is the invariant that protects every downstream reader from observing a partial state. The `relockContract` MCP tool owns this sequence end-to-end; the orchestrator is responsible only for writing the audited draft to the supplied `.draft-tmp.<token>.json` path before invoking the tool.
- **Active revision index lives in `progress.json.contractRevision`.** The original locked contract is revision `0`; each successful re-lock increments the field by `1`. The orchestrator is the sole writer; downstream consumers read it to disambiguate which revision a generator attempt or a reviewer bundle was authored against.

**In-flight status.** While a round is running — between the orchestrator deciding step 4 must fire and the atomic swap completing in step 5 — `progress.json.status` reads `"negotiating"`. After the swap completes (or the round resolves without one), the status returns to `"building"`. Observers (the human operator, the trace consumer) read this transition to know that a renegotiation round is in flight.

**Crash mid-renegotiation.** If the round crashes before the atomic swap completes, the prior canonical contract stays authoritative — its file is byte-identical to what was on disk before the round began, because the archive step happens first and the swap is the single atomic rename that flips authority. Any partial draft on disk lives at a recognisable `sprint-{N}-contract.draft-tmp.<token>.json` path, distinguishable from both the canonical file and the archived siblings, so a recovery flow can identify and ignore unlocked partial drafts without consulting an external manifest.

## Spawn discipline (summary)

Sub-agents are spawned only as part of the regular invocation flow. They are never spawned during a help short-circuit, a print-config short-circuit, or a recovery short-circuit. Each spawn receives the captured run context (worktree path, sprint number, attempt number, contract path) and the resolved configuration object. The orchestrator also exports `GAN_RUN_ID`, `GAN_WORKTREE`, and `GAN_RUN_DIR` into the spawn environment (see "Confinement"), so the confinement hook can derive its allowed zones from the resolved worktree and run directory.

The orchestrator parses the artefact each agent writes under `GAN_RUN_DIR` and decides whether to spawn the next agent.
