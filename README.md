# ClaudeAgents

A generative-adversarial development loop for [Claude Code](https://claude.ai/code) — a set of personal agents and a `/gan` skill that orchestrate an autonomous plan → build → evaluate cycle across multiple sprints, entirely inside Claude Code's native agent system.

---

## What it does

`/gan` takes a product description (or a pre-written spec) and runs it through a structured pipeline:

```
User prompt
    │
    ▼
┌─────────┐     writes .gan/spec.md
│ Planner │ ──────────────────────────────────────────────┐
└─────────┘                                               │
                                                          ▼
          ┌─── For each sprint ──────────────────────────────────────┐
          │                                                           │
          │  ┌──────────────────┐   ┌──────────────────┐             │
          │  │ Contract proposer│──▶│ Contract reviewer│             │
          │  └──────────────────┘   └──────────────────┘             │
          │           │ sprint-N-contract.json                        │
          │           ▼                                               │
          │  ┌─────────────────────────────────────────┐             │
          │  │  Build → Evaluate retry loop            │             │
          │  │                                         │             │
          │  │  ┌───────────┐      ┌───────────┐      │             │
          │  │  │ Generator │─────▶│ Evaluator │      │             │
          │  │  └───────────┘      └─────┬─────┘      │             │
          │  │        ▲                  │              │             │
          │  │        └── retry if fail ─┘              │             │
          │  └─────────────────────────────────────────┘             │
          └───────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                        gan/<run-id> branch ready to merge
```

Each sprint builds on the previous one. All work happens in a single git worktree on a dedicated branch based off `develop` (or any branch you choose). When every sprint passes evaluation, the branch is ready to review and merge.

---

## Agents

| Agent | Model | Role |
|---|---|---|
| `gan-planner` | Opus | Turns a prompt or spec directory into a structured `spec.md` with sprint plan and mandatory Security & Privacy section |
| `gan-contract-proposer` | Opus | Proposes measurable acceptance criteria for the current sprint |
| `gan-contract-reviewer` | Opus | Audits the proposed contract for completeness, testability, and security coverage |
| `gan-generator` | Opus | Implements features one at a time with git commits, following secure coding standards |
| `gan-evaluator` | Opus | Scores the implementation against contract criteria; runs a mandatory security pass on every evaluation |

All agents are stored as personal agents (`~/.claude/agents/`) — available across every project.

---

## Skill

| Skill | Invocation |
|---|---|
| `gan` | `/gan <prompt>` |

The skill is the orchestrator. It runs the full pipeline, manages `.gan/` state, creates and tears down the git worktree, enforces retry limits, and records telemetry.

---

## Installation

```bash
git clone https://github.com/Thomas-AppForceOne/ClaudeAgents.git
cd ClaudeAgents
./install.sh
```

This symlinks all agents into `~/.claude/agents/` and the skill into `~/.claude/skills/gan/`. Edits in the repo are reflected immediately without reinstalling.

Verify the install at any time:

```bash
./install.sh --check
```

Restart Claude Code after installing to pick up the new agents and skill.

---

## Usage

### Greenfield project

```bash
# In any directory
/gan "build a CLI password manager in Go"
```

### Existing codebase

```bash
/gan --target ~/projects/myapp "add Stripe payment integration"
```

### Pre-written spec

```bash
/gan --spec ./SPEC.md
```

### Directory of per-feature specs

```bash
/gan --specs ./specs/
```

### Common options

```bash
/gan --base-branch main --target ~/projects/myapp "refactor auth"
/gan --branch-name feature/payments --target ~/projects/myapp "add payments"
/gan --max-attempts 2 --threshold 8 "build a REST API"
```

| Flag | Default | Meaning |
|---|---|---|
| `--target <path>` | — | Existing codebase to work on |
| `--spec <path>` | — | Skip the planner; use this spec file |
| `--specs <dir>` | — | Assemble spec from a directory of `.md` files |
| `--base-branch <name>` | `develop` | Branch to base the run worktree on |
| `--branch-name <name>` | `gan/<run-id>` | Name for the output branch |
| `--max-attempts <n>` | 3 | Max generator attempts per sprint |
| `--threshold <n>` | 7 | Minimum score per criterion (1–10) |

---

## State directory

Every `/gan` run writes state to `.gan/` in the current working directory:

```
.gan/
├── progress.json                  # current status, sprint counters
├── spec.md                        # planner output
├── worktree/                      # git worktree (active during run)
├── sprint-1-contract.json         # negotiated acceptance criteria
├── sprint-1-feedback-1.json       # evaluator output, attempt 1
├── sprint-1-feedback-2.json       # evaluator output, attempt 2 (if retried)
├── sprint-2-contract.json
└── sprint-2-feedback-1.json
```

Interrupted runs are resumable — `/gan` detects an incomplete `progress.json` and asks whether to resume or start fresh.

---

## Git workflow

The orchestrator creates one branch for the entire run, based off your configured base branch:

```
develop  ← never touched
└── gan/<run-id>
    ├── feat: sprint 1 — user auth
    ├── feat: sprint 2 — dashboard
    └── feat: sprint 3 — notifications
```

On a failed attempt within a sprint, the worktree is reset to the commit at the start of that sprint before the generator retries — no broken intermediate commits accumulate.

When all sprints pass, the branch is ready to inspect and merge:

```bash
git checkout develop
git merge --no-ff gan/<run-id>
```

---

## Security

Security is embedded at every stage rather than treated as a separate concern:

- **Planner** — screens for harmful intent; adds a mandatory *Security & Privacy* section to every spec covering threat surface, trust boundaries, data classification, encryption requirements, secrets management, input validation, privacy/compliance signals, and logging hygiene
- **Contract proposer** — generates security criteria for every surface the sprint introduces (auth, injection safety, secrets hygiene, TLS, dependency safety, secure defaults, error handling, cryptography)
- **Contract reviewer** — rejects contracts that skip security criteria for surfaces the sprint actually touches
- **Generator** — follows standing secure coding standards on every feature: no hardcoded secrets, parameterised queries, safe subprocess calls, established auth libraries, modern crypto only, pinned and audited dependencies, restrictive file permissions, secure defaults
- **Evaluator** — runs a mandatory security pass before scoring: hardcoded secrets grep, dependency CVE audit, injection surface review, auth spot-check, log hygiene check; findings without a contract criterion go to `blockingConcerns` and trigger contract renegotiation

---

## Telemetry

Each run writes a structured record to `~/.gan-telemetry/` (configurable with `--telemetry-dir`). The log survives project deletion and can be queried to compare model configurations:

```bash
jq -s 'group_by(.label) | map({label: .[0].label, runs: length, passRate: (map(select(.status == "complete")) | length) / length})' \
  < ~/.gan-telemetry/runs.jsonl
```

Disable with `--no-telemetry`.

---

## Requirements

- [Claude Code](https://claude.ai/code) with an active Claude subscription
- `git` in PATH
- The target repository must have a clean working tree before running `/gan`

---

## License

MIT
