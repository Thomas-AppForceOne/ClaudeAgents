# ClaudeAgents

ClaudeAgents is a configuration-driven framework for [Claude Code](https://claude.ai/code). It runs a generative-adversarial development loop — plan, contract, build, evaluate, retry — across multiple sprints, and lets each project tune that loop through stack files and overlays rather than by editing prompts.

The framework is **dual-callable**: every operation is reachable from inside Claude Code via the `/gan` skill (which talks to a local MCP server) and from the terminal via the `gan` CLI. Both surfaces share the same underlying configuration API; there is one source of truth and two transports.

---

## What it does

A `/gan` run takes a prompt or a written spec and drives it through a structured pipeline:

```
User prompt
    │
    ▼
┌─────────┐
│ Planner │  produces a sprint plan
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
gan/<run-id> branch ready to review and merge
```

Per-run artefacts (sprint contracts, evaluator feedback, the worktree, progress state) live under `.gan-state/runs/<run-id>/`. When every sprint passes evaluation, the branch is ready to inspect and merge.

---

## Architecture

ClaudeAgents is configuration-driven. The agents that drive a run never parse files directly — they call a configuration API and consume the result as data. The framework is built around three ideas:

### Three project zones

Each project has up to three on-disk areas, each with a single owner and a clear lifecycle (modelled on POSIX `/etc`, `/var/lib`, `/var/cache`):

| Zone | Path | Role | Hand-edited? | Committed? |
|---|---|---|---|---|
| 1 | `.claude/gan/` | Project configuration: project overlay, project-tier stack files. | Yes (or via the `gan` CLI). | Yes. |
| 2 | `.gan-state/` | Durable run state: per-run progress, archived runs, trust history. | No. | No (gitignored). |
| 3 | `.gan-cache/` | Ephemeral cache: regenerable indices, lookup tables. | No. | No (gitignored). |

Zone 1 holds intent (what you want), zone 2 holds history (what happened), zone 3 holds caches (what can always be rebuilt). Configuration always flows through the API — agents never read files in any zone directly.

### Three-tier overlay cascade

The three-tier overlay cascade decides which value wins for a given splice point. Tiers from lowest to highest:

1. **Built-in tier** — defaults shipped with the framework (`stacks/<name>.md` in this repo).
2. **User tier** — your global settings at `~/.claude/gan/` (overlay only; one user file per machine, applied to every project).
3. **Project tier** — the project's own settings under `.claude/gan/` (overlay and shadow stack files).

The cascade has two halves with different semantics:

- **Overlay fields merge per-field.** Higher tiers add to or replace specific splice points; lower-tier values survive unless explicitly discarded. The merge rule for each splice point is fixed by the schema (union by string, union by key, scalar override, project-only).
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

The installer symlinks the agent prompts into `~/.claude/agents/`, links the skill into `~/.claude/skills/gan/`, runs `npm install -g .` from the repo root, and registers the configuration MCP server with Claude Code. Re-running `./install.sh` is a no-op when the install is up to date.

To check or remove an existing install:

```bash
./install.sh --check
./install.sh --uninstall
```

Restart Claude Code once after the first install. Subsequent updates do not require a restart.

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
/gan --print-config
/gan --help
```

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

The full overlay schema lives in [`schemas/overlay-v1.json`](schemas/overlay-v1.json); the stack schema in [`schemas/stack-v1.json`](schemas/stack-v1.json).

---

## Inspecting, recovering, and cleaning up runs

```
/gan --print-config             # Inspect the resolved configuration. Fail-open.
/gan --list-recoverable         # List previously-archived runs that can be resumed.
/gan --recover --run-id <id>    # Resume an archived run.
/gan --cleanup                  # Delete the most recent non-complete run.
/gan --cleanup --run-id <id>    # Delete one specific run.
/gan --cleanup --all            # Delete every non-complete run.
/gan --cleanup --all --include-terminal  # Delete every run (terminal included).
```

The inspection, recovery, and cleanup short-circuits run validation in non-aborting mode, so a project with a known-broken configuration can still be inspected or cleaned up.

`--cleanup` prints a preview table (run id, status, sprint, size) and prompts `[y/N]` before deleting; pass `--yes` to skip the prompt. Active runs (with a live `run.lock`) are refused. The cleanup never touches `.gan-state/modules/`, `.claude/gan/`, or `.gan-cache/`.

---

## Requirements

- [Claude Code](https://claude.ai/code) with an active Claude subscription.
- macOS is the supported platform for v1. Linux works best-effort. Windows is out of scope.
- `git` in `PATH`.
- Node 20.10+ (the installer checks; the runtime is bundled).
- A clean working tree before running `/gan`.

---

## Repository layout

```
.
├── agents/              Agent prompts (read by Claude Code)
├── skills/gan/          The /gan skill orchestrator
├── stacks/              Built-in stack files (web-node, generic)
├── schemas/             Published JSON Schemas (stack, overlay, …)
├── src/                 TypeScript source (config server, CLI, evaluator core)
├── tests/               Vitest test suites (unit, integration, fixtures)
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
