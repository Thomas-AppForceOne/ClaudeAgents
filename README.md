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

## Inspecting and recovering a run

```
/gan --print-config           # Inspect the resolved configuration. Fail-open.
/gan --list-recoverable       # List previously-archived runs that can be resumed.
/gan --recover --run-id <id>  # Resume an archived run.
```

The inspection and recovery short-circuits run validation in non-aborting mode, so a project with a known-broken configuration can still be inspected.

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

- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — Vitest run.
- `npm run lint` — ESLint.
- `npm run format:check` — Prettier check.
- `npm run lint-stacks` — schema and discipline checks for `stacks/*.md`.
- `npm run lint-no-stack-leak` — guards against ecosystem-token leakage outside owning stack files.
- `npm run lint-error-text` — checks user-facing error strings for the iOS-developer-on-macOS readability rule.
- `npm run publish-schemas` — publish JSON Schemas under `schemas/`.
- `npm run pair-names` — verifies module ↔ stack pairing.
- `npm run evaluator-pipeline-check` — the deterministic core of the evaluator pipeline (no LLM in CI).

---

## License

MIT
