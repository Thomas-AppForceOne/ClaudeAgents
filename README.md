# ClaudeAgents

ClaudeAgents is a configuration-driven framework for [Claude Code](https://claude.ai/code). It runs a generative-adversarial development loop — clarify, plan, contract, build, evaluate, retry — across multiple sprints, and lets each project tune that loop through stack files and overlays rather than by editing prompts.

The framework is **dual-callable**: every operation is reachable from inside Claude Code via the `/gan` skill (which talks to a local MCP server) and from the terminal via the `gan` CLI. Both surfaces share the same underlying configuration API; there is one source of truth and two transports.

---

## What it does

A `/gan` run takes a prompt or a written spec and drives it through a structured pipeline:

```
User prompt
    │
    ▼
┌───────────┐
│ Clarifier │  resolves ambiguity into an explicit clarified spec,
└─────┬─────┘  shown as an interactive draft for you to approve/edit/evolve
      │ clarified-spec.md
      ▼
┌─────────┐
│ Planner │  produces a sprint plan from the clarified spec
└────┬────┘
     │
     ▼
┌──────────────────────────────────────────────────────┐
│ For each sprint:                                     │
│                                                      │
│   contract proposer  ─►  contract reviewer           │
│            │                                         │
│            ▼                                         │
│   ┌──────── build → evaluate retry loop ────────┐    │
│   │   generator  ─►  evaluator                  │    │
│   │       ▲              │                      │    │
│   │       └── retry on failure ─────────────────┘    │
│   └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
     │
     ▼
run branch (reused or task-named) ready to review and merge
```

Before planning, a **clarification pass** turns your raw prompt into an explicit spec: it names the ambiguities, fills the ones it safely can with defaults, and surfaces the rest as best-guess assumptions you can override. The clarified spec is shown as a single draft with an action menu — **`[a]`pprove / `[e]`dit / `evolve: <text>` / `[c]`ancel** — that auto-approves after a timeout (default 60s) so an unattended run never stalls. Pass `--skip-clarification` to bypass it (the orchestrator then plans straight from the raw prompt), and a perfectly-specified prompt skips the draft preview automatically. The raw prompt and the clarified spec are both preserved in the run's data for audit.

Per-run *data* — the clarified spec, sprint contracts, evaluator feedback, progress state, the run trace — lives in a central, repo-keyed store outside any worktree (`~/.gan-runs-data/<repo-key>/runs/<run-id>/`), so it survives `git worktree remove`. The code is written in the run's worktree: the task worktree you launched from when it matches the task (case 1a), or a gan-created run-scoped worktree at `.gan-state/runs/<run-id>/worktree/` otherwise (cases 1b/1c). When every sprint passes evaluation, the branch is ready to inspect and merge.

The build → evaluate retry loop is **bounded**: loop & thrash detection halts a sprint that stops converging — a role exhausting its attempt ceiling, the combined work exceeding the sprint-wide budget, or the generator oscillating between edits — with a structured `LoopDetected` error instead of retrying without limit. The ceilings are configurable per project, and a halted run is recoverable (see [Configuration recipes](#configuration-recipes) and [Inspecting, recovering, and cleaning up runs](#inspecting-recovering-and-cleaning-up-runs)).

---

## Architecture

ClaudeAgents is configuration-driven. The agents that drive a run never parse files directly — they call a configuration API and consume the result as data. The framework is built around three ideas:

### Three project zones

Each project has up to three on-disk areas, each with a single owner and a clear lifecycle (modelled on POSIX `/etc`, `/var/lib`, `/var/cache`):

| Zone | Path | Role | Hand-edited? | Committed? |
|---|---|---|---|---|
| 1 | `.claude/gan/` | Project configuration: project overlay, project-tier stack files. | Yes (or via the `gan` CLI). | Yes. |
| 2 | `.gan-state/` | Project-local run scratch: a gan-created run worktree (cases 1b/1c). Durable run *data* and durable *module state* live in separate central stores (below), not here. | No. | No (gitignored). |
| 3 | `.gan-cache/` | Ephemeral cache: regenerable indices, lookup tables. | No. | No (gitignored). |

Zone 1 holds intent (what you want), zone 2 holds project-local run scratch (the gan-created worktree), zone 3 holds caches (what can always be rebuilt). Configuration always flows through the API — agents never read files in any zone directly.

**Run data lives outside the project.** Durable per-run data — progress, sprint contracts, evaluator feedback, the run trace, telemetry — is written to a central, repo-keyed store outside any worktree (default `~/.gan-runs-data/<repo-key>/runs/<run-id>/`, set at install time with `./install.sh --runs-dir=<path>`). This is what makes run data survive `git worktree remove` and be discoverable from every linked worktree of the repo. Override the store root for a single run with `GAN_RUNS_DATA=<path>`.

**Module state lives outside the project too.** Durable cross-run *module* state — notably the Docker module's port registry — is written to a **separate** central, repo-keyed store (default `~/.gan-module-state/<repo-key>/<module>/`, set at install time with `./install.sh --module-state-dir=<path>`; override per-run with `GAN_MODULE_STATE=<path>`). Keeping it repo-wide rather than per-worktree is what lets the port registry coordinate host-port allocations across every worktree of a repo without collisions, and what makes it survive `git worktree remove`. It is config-server-managed — only the framework's server process writes it, so, unlike the run-data store, it needs no Claude Code permission grant.

### Three-tier overlay cascade

The three-tier overlay cascade decides which value wins for a given splice point. Tiers from lowest to highest:

1. **Built-in tier** — defaults shipped with the framework (`stacks/<name>.md` in this repo).
2. **User tier** — your global settings at `~/.claude/gan/` (overlay only; one user file per machine, applied to every project).
3. **Project tier** — the project's own settings under `.claude/gan/` (overlay and shadow stack files).

The cascade has two halves with different semantics:

- **Overlay fields merge per-field.** Higher tiers add to or replace specific splice points; lower-tier values survive unless explicitly discarded. The merge rule for each splice point is fixed by the schema (union by string, union by key, scalar override, per-role map merge, project-only).
- **Stack files replace wholesale.** A project-tier stack file shadowing a built-in name replaces the entire built-in file. Stack files are structurally rich (detection trees, scope globs, security surfaces); merge semantics would be ambiguous, so the rule is "highest tier wins, top-to-bottom".

If you only need to tweak a known splice point, write an overlay. If you need to fork an ecosystem's behaviour wholesale, fork the stack file.

### Stacks are data, not code

Every per-ecosystem behaviour lives in `stacks/<name>.md` — detection patterns, scope globs, lint/test/build commands, security surfaces. Two stack files ship with the framework (`web-node` and `generic`), and you can fork or author your own without touching agent prompts.

This is what makes the framework retargetable: extending it to a new ecosystem is writing a stack file, not patching a prompt.

### Dual-callable surface

Every public operation is exposed twice from the same underlying functions:

- **From Claude Code:** the `/gan` skill drives the orchestrator; agents call the configuration API through a local MCP server.
- **From the terminal:** the `gan` CLI is a thin wrapper that calls the same library functions in-process.

Both routes share the same exit codes, the same JSON output format (`--json`), the same error contracts, and the same trust model. Anything the orchestrator can do, you can also script.

---

## Installation

Local install for now (the package is not yet on a registry):

```bash
git clone https://github.com/Thomas-AppForceOne/ClaudeAgents.git
cd ClaudeAgents
./install.sh
```

The installer symlinks the agent prompts into `~/.claude/agents/`, links the skill into `~/.claude/skills/gan/`, runs `npm install -g .` from the repo root, registers the configuration MCP server with Claude Code, configures the central run-data store (recording its path and granting Claude Code persistent access to it), and records the central module-state store location (a marker only — no permission grant, since the config server manages that store itself). Re-running `./install.sh` is a no-op when the install is up to date.

To set the central store locations, or to remove an existing install:

```bash
./install.sh --runs-dir=<path>           # central run-data store root (default ~/.gan-runs-data)
./install.sh --module-state-dir=<path>   # central module-state store root (default ~/.gan-module-state)
./install.sh --uninstall
```

Restart Claude Code after running the installer so it picks up the agents, skill, and config server.

---

## v1.0 release notes

### Migrating a legacy project-tier confinement hook

The framework confines every `/gan` sprint to its run directory with a PreToolUse hook (`gan-confine.sh`). In v1.0 the framework owns that hook: `./install.sh` writes it to `~/.claude/hooks/gan-confine.sh` and refreshes it on every install, so a filesystem-zone rework upgrades automatically instead of silently breaking each project.

Earlier setups copied the hook into the project at `.claude/hooks/gan-confine.sh`. A project-tier hook still takes precedence over the framework's user-tier hook, and the framework **never** auto-migrates or deletes it — removing it is your explicit call. If you carry a legacy project hook (one that references the retired `.gan/` zone layout), migrate like this:

1. Run `./install.sh`. It writes the current user-tier hook to `~/.claude/hooks/gan-confine.sh`. When you run it from inside a project that has a project-tier hook, it prints an override warning telling you the user-tier hook will not be used in that project.
2. Inspect both tiers with `gan hooks status`. It reports the user-tier hook path and authoring framework version, any project-tier hook in the current directory, and — when the project hook still references the legacy `.gan/` layout — a deletion hint.
3. If the project hook is a legacy copy and not a deliberate override, delete it with `rm .claude/hooks/gan-confine.sh`. The framework's current user-tier hook then applies. If it is a deliberate override (narrower or wider confinement on purpose), keep it and update it by hand to match the framework's current zone layout.

### A pre-existing project-local `.gan-state/runs/`

Run data now lives in a central, repo-keyed store outside any worktree (default `~/.gan-runs-data`, set at install time with `./install.sh --runs-dir=<path>`) so it survives `git worktree remove`. The framework does **not** migrate older run data: a pre-existing project-local `.gan-state/runs/` is reported once and then left untouched for you to delete or archive by hand — there is no automatic migration. When you no longer need that legacy run data, remove it with `rm -rf .gan-state/runs` (or move it somewhere for archival). New runs write only to the central store.

---

## Quick start

Inside Claude Code, after install:

```
/gan "build a CLI password manager in Go"
/gan --target ~/projects/myapp "add Stripe payment integration"
/gan --spec ./SPEC.md
/gan --skip-clarification "regenerate the changelog"   # plan straight from the prompt, no draft preview
/gan --print-config
/gan --help
```

By default `/gan` runs in a fresh run-scoped worktree under `.gan-state/runs/<run-id>/worktree/` on a task-named branch. Run it from a worktree already dedicated to the task's branch and it reuses that worktree in place; pass `--new-worktree` to force a fresh one regardless.

From the terminal:

```bash
gan --help
gan stacks list
gan validate
gan stacks new my-stack
```

If your project has no recognised ecosystem yet, the framework runs against the universal `generic` stack and prints a non-suppressible nudge pointing you at `gan stacks new` to scaffold your own.

---

## The `gan` CLI

The CLI is the dual of the `/gan` skill — same operations, different transport. Common subcommands:

| Command | What it does |
|---|---|
| `gan --help` | Print top-level help. |
| `gan validate` | Run the configuration validator. Exits non-zero on validation failure with a structured report. |
| `gan stacks list` | List the stacks the framework can see for the current project (with their tier provenance). |
| `gan stacks new <name>` | Scaffold a new stack file under `.claude/gan/stacks/<name>.md` with a DRAFT banner. |
| `gan stacks customize <name>` | Fork an existing stack into the project tier so you can edit it. |
| `gan trust info` | Show the trust state for the current project. |
| `gan trust approve` | Approve the project's current overlay contents. |
| `gan trust revoke` | Revoke an existing approval. |
| `gan trust list` | List every approved project on this machine. |

`gan <cmd> --help` prints per-subcommand help. `gan <cmd> --json` emits the API response (or structured error) as JSON for scripting.

---

## Trust

The project overlay can change how the framework runs — what commands the evaluator invokes, what files it reads, what splice points it injects. Overlays committed by other people are an attack surface. ClaudeAgents addresses this with a content-hash trust cache:

- The framework hashes the active overlay set on every `/gan` invocation.
- An untrusted hash triggers an interactive prompt: approve and run, run with `--no-project-commands` (skip every project-sourced command), or cancel.
- Approvals are stored in the user-tier trust cache; revoke with `gan trust revoke` or run `gan trust list` to audit.
- `GAN_TRUST=strict` makes the prompt fail closed (for CI). `GAN_TRUST=unsafe-trust-all` skips the check entirely (logged loudly).

---

## Configuration recipes

Most projects need nothing — the framework auto-detects a stack and runs. A few common tweaks:

- **Add a planner context file**: edit `.claude/gan/project.md` and set `planner.additionalContext: ['docs/architecture.md']`.
- **Override the lint command for a stack**: `gan stack update web-node lintCmd 'npm run lint:next'`.
- **Force the active stack set**: in `.claude/gan/project.md`, set `stack.override: ['web-node']` (replaces auto-detection).
- **Skip every project-sourced command for one run**: `/gan --no-project-commands "review someone's branch"`.
- **Tune the loop's safety ceilings**: in `.claude/gan/project.md`, set `safety.attemptCeilings.gan-generator: 5` to give the generator more revision rounds, `safety.sprintBudget: 16` to raise the sprint-wide cap, or `safety.oscillationDetection: false` to turn off edit-oscillation halts. For a one-off override, pass `/gan --max-attempts=5` (a uniform per-role ceiling for that run).
- **Adjust the clarifier draft-preview timeout**: in `.claude/gan/project.md`, set `clarifier.draftTimeoutSeconds: 120` (integer in the range 10–600; default 60) to give yourself longer before a draft auto-approves. For a one-off override, pass `/gan --clarifier-timeout=120`. A value of `0` is rejected (`InvalidTimeoutValue`) — use `--skip-clarification` to bypass the phase instead.

The full overlay schema lives in [`schemas/overlay-v1.json`](schemas/overlay-v1.json); the stack schema in [`schemas/stack-v1.json`](schemas/stack-v1.json); the strict `progress.json` schema (the per-run state file every writer must conform to) in [`schemas/progress-v1.json`](schemas/progress-v1.json).

---

## Inspecting, recovering, and cleaning up runs

```
/gan --print-config             # Inspect the resolved configuration. Fail-open.
/gan --list-recoverable         # List runs eligible for recovery (repo-wide, from the central store).
/gan --recover --run-id <id>    # Resume an interrupted run (only from the worktree it ran in).
/gan --recover --reset-attempts # Resume, restarting the attempt counters from zero.
/gan --cleanup [...]            # Reserved; deferred to v1.1 (prints a "requires v1.1" notice and exits non-zero).
```

The inspection and recovery short-circuits run validation in non-aborting mode, so a project with a known-broken configuration can still be inspected or recovered.

A run halted by loop & thrash detection (a `LoopDetected` exit, distinct from validation and contract failures) is recoverable like any other interrupted run. `--recover` rebuilds the per-role attempt counters from the run trace, so a sprint that was still looping halts again on the next attempt unless you change the prompt — or pass `--reset-attempts` (valid only alongside `--recover`) to resume with the counters reset to zero.

`--list-recoverable` enumerates the repo's runs from the central store, so they are visible from any worktree; but a run is **resumable only from the worktree it ran in** (its working tree and branch live there), and `--recover` refuses from anywhere else, naming the right worktree.

**`--cleanup` is reserved in v1.0 and ships only as an inert stub:** invoking it (with any modifier) prints a structured `[deferred-to-v1.1]` notice and exits non-zero without touching disk. The full destructive surface — preview table, `[y/N]` prompt, `--yes`, merge-aware run-branch deletion, scope flags like `--all` / `--include-terminal` — ships in v1.1, when the already-tested cleanup-planner library is wired up as a deterministic tool the orchestrator can invoke. Until then, remove unwanted runs by hand: `rm -rf ~/.gan-runs-data/<repo-key>/runs/<run-id>` (or your `GAN_RUNS_DATA` override), then `git worktree remove .gan-state/runs/<run-id>/worktree --force` for a gan-created worktree, and `git branch -D <branch>` for the run branch if you no longer need it. Module state (`~/.gan-module-state/<repo-key>/`), `.claude/gan/`, and `.gan-cache/` are never run-state and never need cleanup.

**The stranded-self-lock case.** A `--recover` against a run whose lock is held by a live pid carrying the *same* `runId` (which happens when the long-lived config-server pid outlives the run that took the lock) gets a distinct error — `StrandedSelfLock`, not the generic `ConcurrentRunInProgress` — that names the exact lock path and tells you to clear the stale lock with `rm <lockPath>` if no `/gan` session is actively running that run. A *different*-`runId` live lock still surfaces the generic refusal; a dead-pid lock is silently stale-broken. This means you don't have to guess whether the holder is your config-server or another live session.

---

## Requirements

- [Claude Code](https://claude.ai/code) with an active Claude subscription.
- macOS is the supported platform for v1. Linux works best-effort. Windows is out of scope.
- `git` in `PATH`.
- Node 20.10+ (the installer checks; the runtime is bundled).
- A clean working tree if `/gan` needs to relocate your current branch into a worktree (it refuses over uncommitted changes); reuse-in-place and fresh-worktree runs don't require it.

---

## Repository layout

```
.
├── agents/              Agent prompts (read by Claude Code)
├── skills/gan/          The /gan skill orchestrator
├── stacks/              Built-in stack files (web-node, generic)
├── schemas/             Published JSON Schemas (stack, overlay, …)
├── src/                 TypeScript source (config server, CLI, evaluator core, trace, safety)
├── tests/               Vitest test suites (unit, integration, fixtures)
├── templates/           Packaged templates (e.g. Claude Code settings)
├── specifications/      The RFC + roadmap (authoritative)
└── scripts/             Maintainer tooling (see Contributing)
```

---

## Contributing

If you are working on the framework itself rather than using it, see [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md) for the tech stack, conventions, and review rules.

### Maintainer scripts

These are not part of the user-facing surface; they exist for repository maintainers and CI.

The common workflow is wrapped in a `Makefile` — run `make` (or `make help`) to see the targets, or invoke the underlying npm scripts directly.

**Make targets:**

- `make build` — compile TypeScript to `dist/`.
- `make test` — Vitest run (stubbed install/uninstall via fake binaries).
- `make lint` — ESLint.
- `make typecheck` — `tsc --noEmit`.
- `make format-check` — Prettier check.
- `make check` — full pre-release gate: build → typecheck → lint → format-check → test.
- `make test-install-live` — pre-release-only live install round-trip; exercises the real `npm install -g .`, the real installed binary, and every flag combination on disk. Not part of `make test` (or `npm test`). See [`tests/installer/live-install.sh`](tests/installer/live-install.sh).
- `make clean` — remove `dist/`.

**Underlying npm scripts** (used directly when you want flag forwarding, or invoked by Make):

- `npm run build`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`.
- `npm run test:install:live` — same as `make test-install-live`.
- `npm run lint-stacks` — schema and discipline checks for `stacks/*.md`.
- `npm run lint-no-stack-leak` — guards against ecosystem-token leakage outside owning stack files.
- `npm run lint-error-text` — checks user-facing error strings for the iOS-developer-on-macOS readability rule.
- `npm run doc-lint` — documentation linter for the framework's TypeScript surface (the deterministic layer behind `web-node`'s `docLintCmd`); over the merge-base delta it gates an introduced export that lacks a doc comment, and reports the required-sections / commented-out-code heuristics as non-blocking advisories. Pass `--require-base` to fail instead of degrade when no baseline resolves (used by the `test-doc-lint` CI gate).
- `npm run publish-schemas` — publish JSON Schemas under `schemas/`.
- `npm run pair-names` — verifies module ↔ stack pairing.
- `npm run evaluator-pipeline-check` — the deterministic core of the evaluator pipeline (no LLM in CI).

### Pre-release verification

Before cutting a release, run both gates:

```
make check                   # static + unit verification (~30s)
make test-install-live       # live install round-trip (~70s; reinstalls the global package on exit)
```

`make check` covers the vitest suite (stubbed `npm` / fake binaries). `make test-install-live` is the missing piece: it actually places the package on PATH, invokes the real binary, and verifies disk-state side effects of every flag combination under an isolated `HOME`. It auto-cleans sandboxes and restores the global package when finished.

---

## License

MIT
