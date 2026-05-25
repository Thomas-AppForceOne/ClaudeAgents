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
| `--print-config` | n/a | Inspection short-circuit. Calls validation in non-aborting mode, prints the resolved view (plus any structured errors), exits. No worktree, no agents. |
| `--recover` | n/a | Recovery short-circuit. Calls validation in non-aborting mode, dispatches to the recovery flow. No new worktree until recovery resumes. Without `--run-id`, targets the most recent non-terminal run; combine with `--run-id <id>` for a specific run. Recovery is bound to the run's recorded `workspace.worktreePath`: it refuses (non-zero) when invoked from any other worktree. See "Cleanup and recovery" below. |
| `--list-recoverable` | n/a | Inventory short-circuit. Calls validation in non-aborting mode, enumerates the repo's runs under the central store (`<store-root>/<repo-key>/runs/`) so every run is visible from any worktree, prints recoverable runs, exits. |
| `--cleanup` | n/a | Destructive symmetric to `--recover`: always deletes the target run(s) from the central store (`<store-root>/<repo-key>/runs/<run-id>/`), and for a gan-created workspace drops the run worktree and (merge-aware) the run branch. Default targets the most recent non-terminal run. Combine with `--run-id <id>`, `--all`, `--all --include-terminal`, or `--yes` (bypass prompt). Refuses to delete an active run. See "Cleanup and recovery" below. |
| `--run-id <id>` | n/a | Modifier for `--recover` and `--cleanup`. Names the specific run id to act on; the id format is `<YYYYMMDDTHHMMSS>-<4 hex>` (the directory name under `<store-root>/<repo-key>/runs/`). Use `/gan --list-recoverable` to list available ids. |
| `--no-project-commands` | false | Skip every command sourced from `project` and `user` tier files for this run; falls back to `builtin` tier defaults (per F4). |
| `--skip-welcome` | false | Skip the first-run welcome banner. The marker file at `~/.claude/gan/welcomed` is created so subsequent runs also skip the banner. Idempotent — passing this flag on an already-welcomed system is a no-op. See "Welcome banner" below. |
| `--max-attempts <n>` | from config | One-off override of the attempt ceilings for this run. Applies a **uniform** per-role ceiling of `n` to **every** multi-attempt role and sets the sprint-wide budget to `n × roleCount + 4` (the `+4` covers clarifier, planner, reviewer, and evaluator). It **overrides** the overlay's `safety.attemptCeilings.*` and `safety.sprintBudget`: a coarse one-off debugging knob beats persisted config for the run it is passed on. Feeds the resolved effective ceilings and budget into the attempt-start checks (see "Per-role attempt ceilings" and "Sprint-wide attempt budget"). |
| `--reset-attempts` | false | Modifier valid only alongside `--recover`. When set, the recovered sprint resumes with attempt counters at zero; without it, recovery preserves the counters reconstructed from the trace (so a recovered sprint hitting the same loop halts again on the next attempt). |
| `--skip-clarification` | false | Bypass the clarifier; the orchestrator writes a minimal `clarified-spec.md` (the verbatim prompt as Goal) and proceeds straight to the planner. Does NOT short-circuit `validateAll()`. |
| `--clarifier-timeout=<seconds>` | from config (60) | Override the draft-preview auto-approve timeout for this run. Enforces the same `[10, 600]` range as the overlay splice; an out-of-range value (and `0`) is rejected at flag-parse time with `InvalidTimeoutValue`. |

Help output never references maintainer-only scripts. Help text points the user at the `gan` CLI (for example `gan stacks new`, `gan trust info`, `gan config print`) for configuration management, and at `.claude/gan/project.md` for overlay authoring. Help includes at least one realistic invocation example.

The remaining text after flags is the user prompt passed to the planner (when a regular run is invoked).

**Bare invocation (`/gan` with no prompt).** A `/gan` invocation that carries no prompt and no agent-spawn-short-circuiting flag (i.e. not `--help`, `--print-config`, `--list-recoverable`, or `--recover`) is handled by the `NoPromptProvided` check inside the regular invocation flow — there is no separate pre-validation bare-invocation handler. The check fires **after `validateAll()` and after the welcome banner** (when applicable), but **before the clarifier** and **before any run-lockfile is acquired or any run state is created** — a bare invocation never creates run state. There is no point spawning the clarifier on an empty prompt.

It halts with the structured error `NoPromptProvided`, carrying the exact user-facing message:

`No prompt provided. Run `/gan "<your prompt here>"` to start a sprint, or `/gan --help` to see the available options.`

The `--help` hint is mandatory — a user typing `/gan` blind is asking "what does this thing do?", and the answer must point them at the discovery surface. The ordering is `validateAll()` → welcome banner → `NoPromptProvided`; see "Regular invocation flow" below for the precise step placement.

## Welcome banner

The first time `/gan` is invoked **as a regular sprint invocation** (not as a `--help`, `--print-config`, `--list-recoverable`, `--recover`, or `--cleanup` short-circuit), the orchestrator prints a multi-paragraph welcome banner before doing any other work, then continues with the requested action. Per `specifications/I2-install-user-facing-surfaces.md` § "First-run welcome banner".

**Detection.** The marker file at `~/.claude/gan/welcomed` is the welcomed-state signal. Its presence — not its content — is what counts. The file is a zero-byte sentinel and lives under `~/.claude/gan/` (zone 1, configuration tier per F1). The orchestrator checks for the file at startup; absence triggers the banner.

**Short-circuit exemption.** The banner does NOT fire on `--help`, `--print-config`, `--list-recoverable`, `--recover`, or `--cleanup`. A user running `--help` for orientation should see help text, not a banner. A user running `--print-config` to debug is already debugging and needs the print output. A user running `--cleanup` is reclaiming disk space, not asking for a tutorial. The banner fires only when the orchestrator is about to spawn agents on a first-run system.

**Banner content** covers the bullets named in `specifications/I2-install-user-facing-surfaces.md` § "Banner content": what ClaudeAgents is, the pipeline shape (clarifier → planner → contract → generator → evaluator), what trust prompts and the clarifier draft preview look like, what `.gan-state/` accumulates, when to use `--no-project-commands`, where to find docs, and that both `gan` and `/gan` exist with separate purposes. The orchestrator renders this as prose that obeys the F4 prose-discipline rule (the bare ecosystem tokens enumerated under F4 — including the package-manager and runtime names — must appear inside backticks; see F4 for the canonical list).

**Marker-write timing.** The marker is written **after** the banner finishes printing but **before** any downstream agent fires. Ctrl-C during banner display does not write the marker — the user gets a re-show on next run. A user who wants to re-read the banner can `rm ~/.claude/gan/welcomed`.

**`--skip-welcome` flag.** Passing this flag writes the marker without printing the banner. Useful for scripted invocations that don't want even the informational banner output. Idempotent — the marker write is a no-op when the file already exists.

**Non-TTY behavior.** When stdin/stdout are not a TTY (CI, automated scripts), the banner is skipped silently and the marker is created. The first-run experience is shaped for interactive humans; non-interactive contexts should not hit prose output they cannot read.

## Help short-circuit

`--help` runs **before** `validateAll()`. The orchestrator prints the help text to stdout and exits 0. There is no validation, no snapshot, no worktree, and no agent is spawned. A user with a broken project configuration can still discover how to inspect or recover it without first fixing validation. This is the only flag that skips validation entirely.

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
                [--clarifier-timeout <seconds>]

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
  --clarifier-timeout <seconds> Override the draft-preview auto-approve timeout for this run; enforces
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
- **CONFIGURATION**: point the user at the `gan` CLI for configuration management (`gan stacks new`, `gan config print`, `gan trust info`) and at `.claude/gan/project.md` for overlay authoring. Obey the F4 prose-discipline rule: ecosystem-specific package-manager and runtime tokens are forbidden in this file (the F4 spec carries the canonical list).
- **OUTPUT**: where per-run state lives and how branches are named. Mention the `--base-branch` override.

## Inspection and recovery short-circuits

`--print-config`, `--recover`, `--list-recoverable`, and `--cleanup` call `validateAll()` in **non-aborting mode**: any structured errors are captured and surfaced alongside the partial resolved view (for `--print-config`) or in the recovery / cleanup report (for `--recover` / `--list-recoverable` / `--cleanup`). The user can inspect a known-broken project's configuration or reclaim its run state without first fixing validation — this is exactly when fail-open behaviour is most useful.

Specifics:

- `--print-config` calls `getResolvedConfig()` and emits an O1-shaped object on stdout. When validation captured errors, both the partial `resolvedConfig` and the `validationErrors` are emitted as top-level keys; exit code reflects validation status.
- `--recover` and `--list-recoverable` dispatch to the recovery flow (per O2's revision, re-anchored to the central store by F7). Enumeration reads the repo's runs under `<store-root>/<repo-key>/runs/` (repo-wide, so the same runs are listed from any worktree); `--recover` then binds to the run's recorded `workspace.worktreePath` and refuses from any other worktree. Recovery refuses to touch the module-state store, `.claude/gan/`, or `.gan-cache/` (zone ownership rules).
- `--cleanup` dispatches to the cleanup flow described in the "Cleanup and recovery" section below. Like recovery, it never touches the module-state store, `.claude/gan/`, or `.gan-cache/`.

No sprint work runs in any of these paths.

## Cleanup and recovery

Per `specifications/O2-recovery.md`, re-anchored to the central store by `specifications/F7-central-run-data-store-and-worktree-execution.md` § 4. Run *data* lives in the central, repo-keyed store at `<store-root>/<repo-key>/runs/<run-id>/` (not under `<projectRoot>/.gan-state/runs/`), and the serialization lock is `<store-root>/<repo-key>/run.lock` (not `<projectRoot>/.gan-state/run.lock`). The `<repo-key>` is derived from the repo's main-worktree root, so all linked worktrees of one repo share the same store directory and lock — recovery enumeration and the lock are repo-wide.

**Recovery worktree-anchor (`--recover`).** Enumeration is repo-wide, but *resuming* is bound to the worktree the run executed in. `--recover` reads `progress.json.workspace.worktreePath`; when the current invocation is not that worktree it refuses (non-zero) with `Run <id> was executed in worktree <path> (branch <branch>); recover it from there.` If the recorded worktree no longer exists, recovery refuses with the same path plus guidance to recreate it (the run data is safe in the central store; the worktree it must resume into is gone). The run is still *listed* by `--list-recoverable` from any worktree — enumeration is discovery, not resume.

`--cleanup` is destructive. It **always** deletes the target run(s)' central-store directory; for a gan-created workspace it also drops the run worktree and handles the run branch by merge status. A user-owned (case 1a) worktree and branch are never touched. The orchestrator executes these steps without spawning agents.

1. **Run `validateAll()` in non-aborting mode** so a known-broken project can still be cleaned up. Surface captured errors in the cleanup report; do not abort on them.
2. **Resolve target runs.** Enumerate `<store-root>/<repo-key>/runs/` (repo-wide). Symmetric to `--recover`:
   - `--run-id X` → exactly that run.
   - `--all` → every run with `progress.json.terminal: false` (or missing).
   - `--all --include-terminal` → every run regardless of terminal flag.
   - Default (no `--run-id` and no `--all`) → most recent run by mtime with `terminal: false` (same selection as `--recover`).
   - Empty resolve → print `No non-terminal runs found at <store-root>/<repo-key>/runs/.` Exit 0.
3. **Active-run guard.** Read `<store-root>/<repo-key>/run.lock` if present. If its `runId` is in the resolved target set AND its `pid` is still alive (`kill -0 <pid>` on POSIX), refuse: `Cannot clean up <runId>; it is currently active (pid <pid>). Stop the run first.` Exit 1. Stale locks (dead pid) are ignored.
4. **Preview + confirm.** Print a table of the resolved runs (run id, status, sprint, started-at, on-disk size). Sum the count and bytes. Prompt `Delete these runs? [y/N] ` and read one line from stdin. `y` / `Y` proceeds; anything else exits 0 with `Cancelled.` If `--yes` was passed, skip the prompt — still print the table. Non-TTY stdin without `--yes` refuses: `Refusing to delete <N> runs without confirmation. Pass --yes to bypass the prompt.` Exit 1.
5. **Per-run teardown.** For each confirmed run, classify the workspace by `progress.json.workspace.createdByGan`:
   - **gan-created (cases 1b/1c, `createdByGan: true`):**
     - `git worktree remove <workspace.worktreePath> --force` (silent if the worktree is not registered).
     - Determine the run branch's merge status **before any deletion**: `git merge-base --is-ancestor <branch> <base>` (exit 0 = merged), with `<base>` from the recorded `baseBranch`, else the resolved default branch (`origin/HEAD` → `init.defaultBranch` → `develop`/`main`/`master`), and the branch's `@{upstream}` consulted when set. `<branch>` is `progress.json.workspace.branch` (falling back to `runBranch`).
       - **Merged** → `git branch -D <branch>` locally, and `git push <remote> --delete <branch>` on the remote when a tracking branch exists.
       - **Not merged** → warn (naming the branch) and do **not** delete it without confirmation or `--yes`.
   - **user-owned (case 1a, `createdByGan: false`):** never touch the worktree or branch.
   - **Always:** `rm -rf <store-root>/<repo-key>/runs/<runId>` (the central-store run directory — the source-of-truth artifact).
   - Per-step failures other than the final central-store `rm` are logged as a per-run warning and do not abort the batch. A failed `rm` aborts the batch with exit 1 and the run id of the failure.
6. **Single `git worktree prune`** at the end of the batch (not per-run).
7. **Report.** Print one summary line: `Cleaned up <N> runs. Freed <X> MB.` If any per-run warnings fired, append `<M> run(s) had teardown warnings; see above.`

**Forbidden writes during cleanup and recovery** (zone ownership):

- The module-state store — read-only / untouched.
- `.claude/gan/` — read-only.
- `.gan-cache/` — left untouched (regenerable but not run-state).

The orchestrator's only writes are the central-store run-directory deletion (`<store-root>/<repo-key>/runs/<runId>/`) and the git worktree / branch operations on gan-created workspaces. Anything else is a bug.

## Regular invocation flow

The orchestrator follows this order on every regular `/gan` invocation:

1. **Parse args.** Build the flag table from the user's message.
2. **Welcome banner.** Check for `~/.claude/gan/welcomed`. If absent, the user did not pass `--skip-welcome`, and stdin/stdout are TTY, render the welcome banner described in the "Welcome banner" section above. After the banner finishes printing, create the marker (`mkdir -p ~/.claude/gan && touch ~/.claude/gan/welcomed`). On non-TTY invocations the marker is created without rendering the banner. With `--skip-welcome`, the marker is created without rendering the banner regardless of TTY status. If the marker already exists, this step is a no-op.
3. **`validateAll()` (aborting).** Failure aborts the run with the F2 structured error report — no worktree is created, no agent is spawned, and no zone-2 or zone-3 writes occur. The structured error fields (`code`, `file`, `field`, `line`, `message`) are surfaced verbatim. The user-facing remediation hint (when present) is forwarded as-is; the orchestrator does not paraphrase or interpret API errors.
4. **`NoPromptProvided` check.** If the invocation carries no prompt and no agent-spawn-short-circuiting flag (not `--help`, `--print-config`, `--list-recoverable`, or `--recover`), halt here with the structured error `NoPromptProvided` and the exact message `No prompt provided. Run `/gan "<your prompt here>"` to start a sprint, or `/gan --help` to see the available options.` This check runs **after** `validateAll()` (step 3) and **after** the welcome banner (step 2), but **before** the clarifier and **before any run-lockfile is acquired or any run state is created** — a bare invocation never creates run state. (See "Bare invocation" above.)
5. **`getResolvedConfig()` — capture the snapshot once.** The returned snapshot is the **single source of truth** for this run. It is data, not configuration. The orchestrator passes it to every spawned agent.

   **Enrich the snapshot with active-stack bodies before spawn.** The F2 `ResolvedConfig` carries only metadata for each active stack — `{tier, path, schemaVersion}` — not the body fields the agents reference (`buildCmd`, `testCmd`, `lintCmd`, `auditCmd`, `secretsGlob`, `securitySurfaces`, `cacheEnv`, `scope`). After `getResolvedConfig()` returns, for each name in `snapshot.stacks.active`, call the API's `getStack(name)` to load the parsed body and attach those fields onto the matching `snapshot.stacks.byName[name]` entry. The result is the "enriched snapshot" — what every agent prompt means by `snapshot.activeStacks[*].buildCmd` etc. Without this enrichment step, agents see undefined per-stack commands and silently degrade to graceful-fallback paths even when the stack file declared the command. Re-enrichment is performed only when the snapshot is re-captured after a `mutated: true` API call (per the freshness rule below); idempotent re-runs against an unchanged snapshot reuse the enriched object.
6. **Print the startup log** (per O1 part A). One structured line summarising the active stacks, overlay sources, additionalContext paths, and discarded fields. Missing sources are listed explicitly; nothing is silently omitted.

   **First-run nudge.** When the active stack set resolves to `stacks/generic.md` only (no real ecosystem stack matched), the startup log emits an additional non-suppressible line. The verbatim text of the contract is reproduced here so the orchestrator can match the spec exactly:

   > 6. **Print the startup log.** Per O1's part A, emit one structured log line summarising the snapshot. **First-run nudge:** when the active stack set resolves to `stacks/generic.md` only (no real ecosystem stack matched), the startup log emits an additional non-suppressible line: `No recognised ecosystem stack — running with generic defaults. For richer behaviour, run \`gan stacks new <name>\` to scaffold a stack file, or fork an existing one from \`stacks/\` as a starting point.` The note appears even when log verbosity is reduced; it is part of the contract that the framework tells non-Node users *something* useful on first run. (A friendlier prose authoring guide is a known follow-up; today the canonical reference is C1's schema spec plus existing stack files.)

7. **Clarification phase.** Unless `--skip-clarification` was passed, spawn `gan-clarifier` with the user prompt, the captured snapshot, the union of every per-agent `additionalContext`, and the bounded directory listing (built from the active stacks' scope globs). The clarifier writes `clarified-spec.md` under the run's state directory and the orchestrator preserves the verbatim original prompt alongside it as `raw-prompt.md`. The orchestrator then renders the draft preview and resolves the user's action (see "Clarification phase" below). The approved `clarified-spec.md` is the planner's primary input — and the proposer reads it for criteria derivation. With `--skip-clarification`, the orchestrator (not the clarifier) writes the minimal `clarified-spec.md` itself and proceeds. This phase runs after the snapshot is captured and the startup log is printed, and before the worktree and sprint loop.
8. **Create the worktree.** Use `.gan-state/runs/<run-id>/worktree` per F1's zone 2. Record run metadata in `.gan-state/runs/<run-id>/progress.json`. The `<run-id>` follows the established `<YYYYMMDDTHHMMSS>-<4 hex>` form.
9. **Spawn the sprint loop.** For each sprint:
   - The planner reads `clarified-spec.md` (the clarifier's output, under the run's state directory) as its **primary input** for the spec and plan it produces.
   - Pass the snapshot to `gan-contract-proposer` (proposes the sprint contract — every security criterion sourced from the active stacks' `securitySurfaces` per C1 template instantiation; the proposer reads `clarified-spec.md` to derive contract criteria).
   - Pass the snapshot and the contract to `gan-generator`.
   - Pass the snapshot, the contract, and the worktree state to `gan-evaluator`. The evaluator's input is **unchanged** — it reads only the contract, never the clarified spec.

   The orchestrator never re-parses configuration files between sprints; it always passes the captured snapshot.

   **Before each attempt of any role** (including the single-attempt clarifier and planner), the orchestrator runs the checks described below: the per-role ceiling check (for multi-attempt roles — see "Per-role attempt ceilings"), the sprint-wide budget check (for every role — see "Sprint-wide attempt budget"), and — before each generator attempt specifically — the edit-oscillation check (see "Edit-oscillation detection"). If any check halts, the orchestrator does not spawn the next attempt; it halts the sprint per the halt contract. Only when no check halts does it proceed to the spawn.

10. **Tear down.** On completion or unrecoverable failure, mark the run terminal in `progress.json` and remove the worktree filesystem (the run branch survives for inspection).

## Snapshot freshness rule

The captured snapshot is **frozen across user-side edits** for the entire run, including across multiple sprints in a multi-sprint plan. Wall-clock time between sprints does not matter; user edits to overlay or stack files mid-run are not picked up until the next `/gan` invocation. This is a deliberate consistency choice — a contract issued in sprint N must remain meaningful when evaluated in sprint N+1.

When any agent's API call returns `{ mutated: true, ... }` (per F2's mutation indicator), the orchestrator records the per-sprint OR of every agent's `mutated` flag; if any agent in the prior sprint produced `mutated: true`, the orchestrator **always** re-snapshots via `getResolvedConfig()` before spawning the next agent. There is no "may" — re-snapshot-after-true-mutation is unconditional. A `mutated: false` result (e.g. duplicate-skip append) does **not** trigger a re-snapshot; durable state is unchanged so downstream-agent visibility remains the same.

## Per-role attempt ceilings

The framework caps how many times a multi-attempt role may attempt the same step within a sprint, so a role that never converges halts the sprint rather than retrying without bound. The roles with a per-role ceiling and their seed default ceilings come from the framework's safety layer (`gan-contract-proposer` and `gan-generator`, each defaulting to 3); single-attempt roles (clarifier, planner) and the once-per-output roles (reviewer, evaluator) carry no per-role ceiling and are never checked here.

**Effective ceilings — resolved once, then fed to the check.** The orchestrator does not consult the seed defaults directly. At run start it resolves the *effective* safety config — the seed defaults, the merged overlay's `safety.*` block (`safety.attemptCeilings.<role>`, `safety.sprintBudget`, `safety.oscillationDetection`), and the one-off runtime flags — with the framework's pure effective-safety-config resolver (precedence flags > overlay > defaults), and threads the resulting effective per-role ceiling map into `checkRoleCeiling` in place of the seed table. An overlay raising one role's ceiling (e.g. `safety.attemptCeilings.gan-generator: 5`) leaves the other roles at their seed defaults — an unspecified role is never dropped. `--max-attempts=<n>` is a one-off coarse override that **beats** the overlay: it applies a uniform ceiling of `n` to every multi-attempt role (and derives the sprint budget, see below). The orchestrator does not re-implement this resolution inline; it calls the resolver and passes the result to the existing checks.

**Timing — checked at attempt-start boundaries.** The orchestrator evaluates the ceiling at the **start** of each attempt, immediately before it would spawn the next attempt of a multi-attempt role. An attempt already in flight always runs to completion; the ceiling is never used to cancel work mid-attempt. This is a deliberate choice of predictable boundaries over fine-grained cancellation: the check fires at one well-defined point in the loop, so the behaviour is easy to reason about, and the cost is at most one extra attempt in the worst case.

**Mechanism — the trace is the only counter.** The orchestrator does not keep its own attempt tally and writes no counter file. It reconstructs the per-role attempt accounting from the run's `agentAttempt` events with the `reconstructRecoveryState` helper and feeds that into the pure `checkRoleCeiling` helper. Reconstructing from the trace is what lets `--recover` resume with the same counts the original run had — a separate counter file would be a second source of truth that recovery could not rebuild.

**On a halt.** When `checkRoleCeiling` returns a halt, the orchestrator:

1. Builds a `safetyHalt` trace event with `buildLoopDetectedBody` and emits it through the run's trace emitter.
2. Surfaces the `LoopDetected` structured error built with `createLoopDetectedError` — its message is plain prose that names the role, its attempt count and ceiling, points the user at the run's trace directory under the central store, and tells them to adjust the prompt (or raise the ceiling) and re-run with `--recover`.
3. Marks the sprint halted and exits with the framework's `LoopDetected` exit code, which is distinct from the validation/contract exit codes so a caller can tell a halt apart from a contract failure.

A halted sprint is recoverable: re-running with `--recover` resumes from the trace, and unless the user changes the prompt or raises the ceiling the next attempt halts again — by design, so a halt is not silently undone.

**Recovery and `--reset-attempts`.** When a loop halt fires, the orchestrator marks the run terminal with `terminalReason: "failed-loop-detected"` (the kebab-case loop-halt reason) so `--recover` can find and resume it. On `--recover`, the framework reconstructs the per-role attempt counters from the run's `agentAttempt` events with `reconstructRecoveryState` (the same trace-as-only-counter mechanism above — there is no separate counter file) and derives the effective starting counters from that reconstructed state:

- **Without `--reset-attempts` (the default), the reconstructed counters are preserved.** A recovered sprint already at its per-role ceiling therefore halts again on the very next attempt-start check. This is by design: a silent counter reset on resume would defeat the purpose of the ceiling, so the user must change the prompt (or raise the ceiling/overlay) for the next attempt to converge differently.
- **With `--reset-attempts`, the recovered sprint resumes with attempt counters at zero,** so it behaves like a fresh sprint that does not immediately halt. `--reset-attempts` is the explicit, recover-scoped opt-in for fresh counters.
- **`--reset-attempts` is valid only alongside `--recover`.** Passing it standalone (without `--recover`) is rejected with a structured usage error: a fresh-counter request only makes sense as a modifier to a recovery, and allowing it to stand alone would be a back door around the ceiling.

## Sprint-wide attempt budget

Independent of the per-role ceilings, the framework caps the **combined** work across a whole sprint: the summed attempt count over every role. This guards against pathological cross-role thrash — a sprint that cycles plan → contract → generate → evaluate → revise without converging, where no single role ever reaches its own ceiling but the roles together burn through the sprint. The seed default sprint-wide budget comes from the framework's safety layer (12); it is the sum of the per-role ceilings (proposer 3 + generator 3 = 6) plus headroom for the roles that carry no per-role ceiling but still consume attempts — the single-attempt clarifier and planner and the once-per-output reviewer and evaluator. The orchestrator feeds the **effective** budget from the resolved effective-safety config (overlay `safety.sprintBudget`, or the `--max-attempts`-derived `n × roleCount + 4`, else the seed default) into `checkSprintBudget`, using the same resolver result as the per-role check.

**Every role counts toward the budget — even the single-attempt ones.** The clarifier and planner have no per-role ceiling (by definition they run once), so the per-role check never fires for them; but their attempts are real work and so they **do** count toward the sprint-wide total. The budget summation includes every role's attempts and special-cases none.

**Timing — checked at attempt-start boundaries, in addition to the per-role ceiling.** The orchestrator evaluates the sprint budget at the **start** of each attempt, immediately before it would spawn the next attempt of any role, alongside the per-role ceiling check. As with the per-role ceiling, an attempt already in flight always runs to completion; the budget is never used to cancel work mid-attempt. The two checks are evaluated together at the same well-defined boundary: if either says halt, the orchestrator halts.

**Mechanism — the same trace counter, no separate state.** The orchestrator keeps no running budget total and writes no counter file. It reconstructs the per-role attempt accounting from the run's `agentAttempt` events with the `reconstructRecoveryState` helper — the same accounting the per-role check uses — and feeds the resulting per-role tally into the pure `checkSprintBudget` helper, which sums it. Reconstructing from the trace is what lets `--recover` resume with the same combined count the original run had; a persisted running sum would be a second source of truth recovery could not rebuild.

**On a halt.** When `checkSprintBudget` returns a halt, the orchestrator follows the same halt sequence as the per-role ceiling, reusing the same machinery rather than a parallel path:

1. Builds a `safetyHalt` trace event with the same `buildLoopDetectedBody` helper (the body carries `safetyClass = "loopDetected"`, `role = "sprint"`, and the `sprintBudgetExceeded` payload) and emits it through the run's trace emitter.
2. Surfaces a `LoopDetected` structured error built with `createSprintBudgetError` — the same `LoopDetected` error code, with `reason = "sprintBudgetExceeded"` and `role = "sprint"`. Its message is plain prose that names the combined attempt count and the budget, points the user at the run's trace directory under the central store, and tells them to adjust the prompt (or raise the budget) and re-run with `--recover`.
3. Marks the sprint halted and exits with the framework's `LoopDetected` exit code — the same code the per-role halt uses, distinct from the validation/contract exit codes.

The synthetic `role = "sprint"` on this halt denotes the aggregate budget, not an agent: it is never itself a multi-attempt role and is never per-role-ceiling-checked. As with a per-role halt, a sprint halted on the budget is recoverable via `--recover`, and unless the user changes the prompt or raises the budget it halts again on the next attempt.

## Edit-oscillation detection

Beyond the attempt-count ceilings, the framework watches the **generator role specifically** for oscillation: a generator that keeps re-proposing the same change (or alternating between two changes) across attempts is not converging even though it may not yet have exhausted its attempt ceiling. The framework catches that and halts it rather than burning the remaining attempts re-litigating an interpretation the evaluator has already rejected.

**What it consumes.** The framework maintains an edit-fingerprint history for the generator across the sprint's attempts: for each generator attempt, the fingerprint of the edit set that attempt proposed (the structural shape of the changes, normalized so that whitespace-only, comment-only, and reordering-only differences collapse to the same fingerprint), paired with a flag recording whether that attempt followed an evaluator rejection. Both come from the trace — the fingerprints from the edit sets recorded per attempt, and the post-rejection flag reconstructed from the rejection the evaluator recorded before the attempt. There is no separate fingerprint file; the trace stays the single source of truth so `--recover` can rebuild the history.

**Two independent triggers.** The framework's safety layer evaluates two triggers over that history, either of which halts on its own:

- **Direct repeat** — the same fingerprint recurs a third time across the history (the *second* repeat). The halt deliberately waits for the second repeat: a single isolated repeat could be an instructed revert, so two same-fingerprint attempts do not yet halt.
- **3-cycle** — an attempt's fingerprint equals the one from two attempts earlier (an A → B → A alternation), catching a generator swinging between two interpretations even when no two adjacent attempts repeat.

**Post-rejection guard.** A repeat is only counted toward a trigger when the repeating attempt followed an evaluator rejection. A generator that reverts a partial edit because the evaluator instructed it to ("undo that") is doing instructed work, not oscillating, so an otherwise-matching repeat that did not follow a rejection does not halt. This is the framework's false-positive guard: the same fingerprint history halts when the repeating attempt is post-rejection and does not when it is an instructed revert.

**Timing — checked at attempt-start boundaries, alongside the other checks.** The framework evaluates the oscillation check at the **start** of each generator attempt, immediately before it would spawn the next generator attempt, alongside the per-role ceiling and the sprint budget. As with those, an attempt already in flight always runs to completion; the check is never used to cancel work mid-attempt.

**Mechanism — the same trace, the pure detector.** The framework keeps no oscillation state and writes no counter file. It reconstructs the generator's per-attempt fingerprint history (with post-rejection flags) from the trace and feeds it into the framework's pure edit-oscillation detector, which returns a halt decision. The detector compares attempts by the fingerprint value the fingerprinting layer already produced; it does not re-derive its own fingerprint, so the normalization rules and the oscillation triggers cannot drift apart.

**On a halt.** When the detector returns a halt, the framework follows the same halt sequence as the per-role ceiling and the sprint budget, reusing the same machinery rather than a parallel path:

1. Builds a `safetyHalt` trace event with the same `buildLoopDetectedBody` helper (the body carries `safetyClass = "loopDetected"`, `role = "gan-generator"`, and the `editOscillation` payload whose evidence is `{ fingerprintSequence, detectedPattern }`) and emits it through the run's trace emitter.
2. Surfaces a `LoopDetected` structured error — the same `LoopDetected` error code, with `reason = "editOscillation"` and `role = "gan-generator"`. Its message is plain prose that names the attempt count and whether the generator repeated one edit or alternated between two, points the user at the run's trace directory under the central store, and tells them to adjust the prompt and re-run with `--recover`.
3. Marks the sprint halted and exits with the framework's `LoopDetected` exit code — the same code the other two halts use, distinct from the validation/contract exit codes.

As with the other halts, a sprint halted on oscillation is recoverable via `--recover`, and unless the user changes the prompt the generator's next attempt halts again on the same history.

**Gated by the effective `oscillationDetection`.** Whether this check runs at all is the resolved effective-safety config's `oscillationDetection` boolean (overlay `safety.oscillationDetection`, else the default `true`). When it is `true` the orchestrator consults the detector as above; when it is `false` the orchestrator skips the oscillation check entirely and a generator that repeats fingerprints proceeds up to its per-role ceiling without an `editOscillation` halt — only the per-role ceiling and sprint-budget checks apply. The gate is on the **call site** (whether the orchestrator consults the detector), not on the detector itself: the framework's pure detector is unchanged, in keeping with the rule that the safety layer never modifies agent behaviour.

## Per-run state versus configuration

Per-run state — `progress.json`, sprint contracts, evaluator feedback, generator artefacts — lives directly under `.gan-state/runs/<run-id>/` (zone 2). It is **not** Configuration API territory. The API is for framework configuration; per-run state is for sprint orchestration. Distinct lanes.

The orchestrator is the sole writer of `progress.json`. Sub-agents may read it but never write it; they communicate state transitions via stdout status lines that the orchestrator parses.

## Error surfacing

Every API error (during validation or during a sprint) is reported with the F2 structured fields preserved verbatim: `code`, `file`, `field`, `line`, `message`. The orchestrator does not interpret, translate, or summarise these. User-facing messages obey F4's discipline: shell remediation (`rm <path>`), references to "the framework" rather than specific runtimes, no maintainer-only script names, readable to a developer who has only run `install.sh`.

## Confinement

The framework-owned PreToolUse confinement hook remains in place. Spawned agents write only inside the resolved worktree and to their designated artefact paths under the run directory. MCP tool calls are not file-system reads; agents may call the API freely from inside a confined worktree.

Before spawning agents at sprint start, the orchestrator exports three absolute-path environment variables that the confinement hook reads to derive its two allowed zones:

- `GAN_RUN_ID` — the active run's identifier (`<YYYYMMDDTHHMMSS>-<4 hex>`). When unset, the hook is a no-op: confinement is a per-sprint constraint, not global.
- `GAN_WORKTREE` — the resolved worktree. This is the user's own worktree when the run reuses a task-named worktree, or the run-scoped worktree the framework created otherwise. Writes anywhere under it are in-bounds.
- `GAN_RUN_DIR` — the central-store run directory that holds the run's artefacts, its `trace/` subtree, and its `telemetry/` subtree. Only the declared artefact subpaths under it are in-bounds.

The hook derives its zones from `GAN_WORKTREE` and `GAN_RUN_DIR` rather than from the project root, because the worktree is not always a fixed sub-path of the project and the run directory lives in the central store outside the project tree. It stays a pure deny-gate: it allows writes inside those two zones and denies everything else (`~/.claude/`, the home directory generally, the module-state directory, the ephemeral cache, and any path outside both zones). `gan hooks status` reports the resolved `GAN_WORKTREE` and `GAN_RUN_DIR` for the active run, or notes that the command is running outside a run.

## Trust integration

When the validation step returns the `UntrustedOverlay` structured error, the orchestrator surfaces the interactive trust prompt **before reaching any command-execution path**. The prompt is a protocol the orchestrator is contracted to obey, not a server-enforced gate: the orchestrator MUST show what the approval covers (the changed or newly-declared command-bearing fields, plus the disclosure that the trust hash does not cover the scripts those commands invoke), wait for explicit consent, and call `trustApprove` **only** when the user chooses `[a]`.

The rendered prompt text and the full `[v]` / `[a]` / `[r]` / `[c]` option set are the single responsibility of [`trust-prompt.md`](trust-prompt.md); the orchestrator renders the first-introduction or config-changed variant per whether `getTrustState(projectRoot)` reports a prior approval, and does not restate the options here.

`GAN_TRUST=strict` makes the prompt fail closed in CI; `GAN_TRUST=unsafe-trust-all` skips the trust check entirely (logged loudly).

## Clarification phase

After the snapshot is captured and the startup log is printed, and before the worktree and sprint loop, the orchestrator runs the clarification phase. Unless `--skip-clarification` was passed, it spawns `gan-clarifier` with the user prompt, the snapshot, the union of every per-agent `additionalContext`, and a bounded directory listing built from the active stacks' scope globs. The clarifier writes `clarified-spec.md` under the run's state directory; the orchestrator preserves the verbatim original prompt alongside it as `raw-prompt.md`. The approved `clarified-spec.md` is the planner's primary input.

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

**Evolution rounds.** A run allows **up to three rounds total** — the initial round plus at most two evolutions. An `evolve: <text>` response re-runs the clarifier with the **original prompt + the accumulated `additionalContext` + the user's evolution text**, producing a fresh `clarified-spec.md` presented via the same draft-preview surface; this counts as one round. The orchestrator preserves each prior-round draft at `clarified-spec.md.round-N` (where `N` is the round number) so the evolution audit trail is recoverable, and `raw-prompt.md` stays the verbatim original — evolutions layer on top, history is never rewritten. Reaching the **third round forces the user to choose approve / edit / cancel**; further evolution attempts are rejected. If a regenerated draft fails schema validation, the orchestrator surfaces the structured error inline, keeps the prior round's draft authoritative, re-presents the action menu against that prior draft, and the failed regeneration still **counts as one round**.

**Editor flow (`[e]dit`).** The orchestrator resolves the editor command via the chain `$EDITOR` → `$VISUAL` → `vi`. If none resolves to an executable on `$PATH`, it halts with the structured error `EditorNotConfigured`, naming all three checked variables and telling the user to set one. It spawns the editor on `clarified-spec.md` and imposes **no sub-timeout** on the editor. On editor exit it **re-validates** the edited `clarified-spec.md` against the same document schema `validateAll()` uses; on validation failure it shows the structured error inline and re-opens the editor on the same file; on success it re-renders the edited draft and re-prompts the action menu. The editor flow does **not** consume an evolution round (only `evolve: <text>` does). Ctrl-C **inside the editor** is treated as "abandon edit; re-render the previous draft and re-prompt the action menu" — it does not cancel the run.

**Signal handling.** Ctrl-C **at the action menu** is treated identically to typing `[c]ancel`: the run halts with the structured error `UserCancelled` and the orchestrator writes the kebab-case terminal reason `aborted-by-user` to `progress.json` (`progress.json.terminalReason`). Run state is preserved, so `--recover` can resume from the same draft if the user changes their mind. This is distinct from Ctrl-C inside the editor, which abandons the edit rather than cancelling the run.

**`--skip-clarification`.** This flag bypasses the clarifier entirely. The **orchestrator** (not the clarifier — it is bypassed) writes the minimal `clarified-spec.md`: `Goal` = the verbatim user prompt; `In scope`, `Out of scope`, and `User actions` empty; `Assumptions` a single entry stating the user invoked `--skip-clarification` and downstream agents proceed with the raw prompt as goal; `Constraints` derived from `additionalContext` and the active stacks. `raw-prompt.md` is preserved alongside. The flag does **not** short-circuit `validateAll()` — clarification happens after validation in the pipeline — and the run proceeds straight to the planner with this minimal spec.

**No-ambiguity case.** When the clarifier produces a `clarified-spec.md` with **zero blockers and no assumptions worth recording**, the orchestrator does **not** present the draft preview or action menu — it proceeds directly to the planner. The user is not interrupted for an empty spec. This is the single-round skip case; the clarifier's attempt is still part of the audit trail even when its output is minimal.

**Trace.** The clarifier emits `agentAttempt`, `llmCall`, `clarifierFinding`, and `clarifierUserAction` events per round, and a `safetyHalt` of class `clarifierCancelled` when the user cancels at the action menu.

## Run-trace integration points

Every `/gan` run writes a structured, append-only event log to `.gan-state/runs/<run-id>/trace/` via the framework's trace library: the orchestrator holds one trace emitter for the run and emits a typed event at each milestone, agent attempt, LLM call, and tool call (`orchestratorMilestone`, `agentAttempt`, `llmCall`, `toolCall`). The trace is the read-substrate for loop detection, recovery, and later cost/accuracy phases — downstream phases read trace events rather than inventing their own logging. The trace lives entirely under `.gan-state/` and is never transmitted off-machine.

The orchestrator/skill runtime wires the following integration points. Each names the framework helper or formatter it calls — those are the unit-tested seams the runtime composes; the timing and placement below are the orchestrator's responsibility.

- **Agent-attempt heartbeat (stderr).** Before an agent's **first** LLM call in an attempt, the orchestrator emits one heartbeat line to stderr so a watching user knows the tool has not frozen. The line is produced by the `formatHeartbeat(role)` formatter and renders exactly `[<role>] thinking...` — metadata only, no payload content. Emitted once per attempt.

- **Per-LLM-call and sprint-end summaries (stderr).** When each LLM call completes, the orchestrator emits the one-line cost/latency summary produced by `formatLlmCallSummary` (reading the `llmCall` event's metric fields). At every sprint termination — graceful completion, loop-detection halt, validation abort, user cancel, or error — it emits the cumulative line produced by `formatSprintSummary` / `formatSprintSummaryFromEvents`, aggregated from the trace. These lines go unconditionally to stderr and carry operational metadata only (token counts, latency, cache-hit status, counts and sums); never prompt or response content, and no dollar cost.

- **Trust-prompt resolution → `trustEvent`.** When the interactive trust prompt resolves (the `[v]` / `[a]` / `[r]` / `[c]` path owned by [`trust-prompt.md`](trust-prompt.md)), the orchestrator records the outcome by building a `trustEvent` with the `buildTrustEventBody` builder and emitting it through the trace emitter. The builder maps the resolution's `promptVariant` and the user's `userChoice` faithfully — in particular, `[a]`/`approve` and `[r]`/`runWithoutProjectCommands` are distinct outcomes and are never collapsed.

- **`validateAll()` abort → `validationAbort`.** When `validateAll()` (aborting mode) fails and aborts the run, the orchestrator builds a `validationAbort` event with the `buildValidationAbortBody` builder and emits it before exiting. The builder copies the framework's F2 error payload (`code`, `message`, and any `file` / `field` / `line`) into the event **verbatim**, so the validation diagnostic in the trace matches the F2 error the user is shown field-for-field.

- **`--recover` → trace-driven resumption.** Recovery reads the archived trace (O2's archive includes the entire trace directory) to reconstruct sprint state with the `reconstructRecoveryState` helper: it resumes sequence numbering **gaplessly** from one past the highest sequence the archive ended on, and reconstructs the per-role attempt-counter state purely from the `agentAttempt` events — **without** any external counter file. The resume sequence is fed to a fresh trace emitter so writing continues to the same trace directory without a gap or a collision. A run halted by the safety layer carries `terminalReason: "failed-loop-detected"`, which is what makes the loop halt discoverable to recovery. Without `--reset-attempts` the reconstructed counters are preserved (so a recovered sprint at its ceiling halts again on the next attempt); `--reset-attempts` — valid only alongside `--recover` — instead resumes with counters at zero. See "Per-role attempt ceilings" → "Recovery and `--reset-attempts`".

- **Loop-detection `safetyHalt`.** The trace reserves the `safetyHalt` event class (a reserved extension point with a `safetyClass` discriminator); the framework's loop-detection layer emits a `safetyHalt` with `safetyClass = "loopDetected"` when it halts a run. The orchestrator builds that event body with the `buildLoopDetectedBody` helper and emits it through the trace emitter at the moment of the halt — the same builder for every loop-detection trigger. Three triggers exist so far. The **per-role ceiling** decision is the pure `checkRoleCeiling` helper; the **sprint-wide budget** decision is the pure `checkSprintBudget` helper; the **edit-oscillation** decision (for the generator role) is the pure `detectEditOscillation` helper. All three are fed state reconstructed from the trace by `reconstructRecoveryState` — the ceiling/budget checks the per-role attempt accounting (the same counters recovery uses), and the oscillation check the generator's per-attempt fingerprint history with post-rejection flags — so there is no separate counter or fingerprint file. When any check returns a halt, the orchestrator surfaces the `LoopDetected` structured error (built with `createLoopDetectedError` for a per-role halt, `createSprintBudgetError` for a budget halt, or `createEditOscillationError` for an oscillation halt; all render user-facing prose pointing at the run's trace directory and `--recover`, and all use the single `LoopDetected` exit code). See "Per-role attempt ceilings", "Sprint-wide attempt budget", and "Edit-oscillation detection" below for the timing.

## Spawn discipline (summary)

Sub-agents are spawned only as part of the regular invocation flow. They are never spawned during a help short-circuit, a print-config short-circuit, or a recovery short-circuit. Each spawn receives the captured run context (worktree path, sprint number, attempt number, contract path) and the resolved configuration object. The orchestrator also exports `GAN_RUN_ID`, `GAN_WORKTREE`, and `GAN_RUN_DIR` into the spawn environment (see "Confinement"), so the confinement hook can derive its allowed zones from the resolved worktree and run directory.

The orchestrator parses the artefact each agent writes under `.gan-state/runs/<run-id>/` and decides whether to spawn the next agent.
