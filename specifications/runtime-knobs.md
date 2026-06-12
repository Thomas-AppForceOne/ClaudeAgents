# ClaudeAgents — Runtime knobs

Single inventory of every flag, env-var value, and prompt branch in the v1.0 runtime-surface design. Authoritative — individual specs reference this table rather than restating their own surfaces, so a surface is inventoried here once its owning spec is **drafted** (it can then be referenced before it ships). **Shipped-status is tracked by the [roadmap](roadmap.md)'s implementation order, not this table** — several entries below belong to drafted-but-unmerged v1.0 specs (the O-series). New knobs are added here by their owning spec's PR.

**On flag duplication.** `--help` appears in the surface table for `/gan` (E1), `install.sh` (R2), and `gan` (R3). The sigil is shared; the implementation is per-spec. There is no single authoritative `--help` — each command surface owns its own help text and exit-code contract, by design (different commands have different things to say). Where this table counts surfaces, `--help` is counted once by sigil per the surface-count rule documented at the bottom of this section.

## Top-level commands

| Surface | Owning spec | Effect |
|---|---|---|
| `/gan` (bare) | E1 | Run a sprint against the current project. |
| `gan` (bare) | R3 | Print top-level help (alias of `gan --help`). |
| `install.sh` (bare) | R2 | Install ClaudeAgents into the current Claude Code environment. |

## `/gan` skill flags

| Flag | Owning spec | Effect | Pre-`validateAll()` short-circuit? |
|---|---|---|---|
| `--help` / `-h` / `help` | E1 | Print help, exit. | Yes — only flag that runs before `validateAll()`. |
| `--print-config` | O1 | Emit resolved-config snapshot via O1's surface; exit. `validateAll()` runs in **non-aborting** mode (partial snapshot + structured errors on failure). | No (validateAll runs but does not abort). |
| `--recover` | O2 | Resume a previously-aborted run. Mechanism prescriptively authored at the post-E1 break. Without `--run-id`, targets the most recent non-terminal run; combine with `--run-id <id>` for a specific run. | No (validateAll runs in non-aborting mode). |
| `--list-recoverable` | O2 | List archived recoverable runs; exit. | No (validateAll runs in non-aborting mode). |
| `--cleanup` | O2 | Symmetric to `--recover` but destructive: delete the target run(s) from the central store (`<store-root>/<repo-key>/runs/`, per F7 — not `.gan-state/runs/`), drop the run worktree, drop the run branch. Default target is the most recent non-terminal run; combine with `--run-id <id>` for a specific run, `--all` for every non-terminal run, `--all --include-terminal` for everything. Confirmation prompt unless `--yes`. Refuses to delete an active run. | No (validateAll runs in non-aborting mode). |
| `--run-id <id>` | O2 | Scope modifier for `--recover` and `--cleanup`. Names the specific run id to act on; the id format is `<YYYYMMDDTHHMMSS>-<4 hex>` (the directory name under the central store `<store-root>/<repo-key>/runs/`, per F7 — not `.gan-state/runs/`). Use `--list-recoverable` to list available ids. | n/a — modifier. |
| `--all` | O2 | Scope modifier for `--cleanup`. Targets every recoverable (non-terminal) run rather than just the most recent. | n/a — modifier. |
| `--include-terminal` | O2 | Scope modifier for `--cleanup --all` (and `--list-recoverable`): also includes runs whose `progress.json.terminal` is true. | n/a — modifier. |
| `--yes` | O2 | Bypasses the `--cleanup` confirmation prompt. The preview table is still printed for the audit trail. | n/a — modifier. |
| `--no-project-commands` | F4 | Run with all project-declared commands suppressed. Recommended when reviewing someone else's branch. | No. |
| `--no-telemetry` | O3 | Skip writing the run's `telemetry/` subdirectory (`config.json` + `outcome.json`) entirely. The `trace/` log and per-sprint artefacts are unaffected — this gates only O3's summary artifacts. Per-run opt-out; v1.0 ships telemetry on by default. | No (telemetry is written after `validateAll()`). |
| `--skip-welcome` | I2 | Skip the first-run welcome banner; the marker file at `~/.claude/gan/welcomed` is created so subsequent runs also skip. Idempotent on already-welcomed systems. | No. |
| `--new-worktree` | F7 | Force case-1c workspace resolution (fresh task-named branch + run-scoped worktree at `<project>/.gan-state/runs/<run-id>/worktree/`) even when the current context would match 1a or 1b. For engineers who want gan isolated from their current working tree. | No. |
| `--max-attempts=<n>` | A1 | One-off attempt-ceiling override for a single run. Applies a **uniform** per-role ceiling of `n` to **every** multi-attempt role (so each capped at `n`), and sets the sprint-wide budget to `n × roleCount + 4`, where `roleCount` is the number of multi-attempt roles and the `+4` is fixed headroom for clarifier, planner, reviewer, and evaluator. **Overrides overlay config** (`safety.attemptCeilings.*` and `safety.sprintBudget`): a coarse debugging knob beats persisted config for the run it is passed on. | No. |
| `--reset-attempts` | A1 | Modifier valid only alongside `--recover`; standalone use (without `--recover`) is rejected with a structured usage error. When set, the recovered sprint resumes with attempt counters at zero. **Without** it, recovery preserves the attempt counters reconstructed from the trace via the `agentAttempt` events (no separate counter file), so a recovered sprint that hits the same loop halts again on the next attempt. | n/a — modifier. |
| `--skip-clarification` | E5 | Bypass the clarifier for this run. The orchestrator (not the clarifier) writes a minimal `clarified-spec.md` — Goal = the verbatim prompt, empty In/Out scope and User actions, a single Assumption naming the skip, and Constraints derived from `additionalContext` and the active stacks — and proceeds straight to the planner; `raw-prompt.md` is preserved alongside. Recommended for CI / scripted invocations where interactive prompting is impossible. | No (clarification runs after `validateAll()`; the flag does not short-circuit validation). |
| `--clarifier-timeout=<seconds>` | E5 | One-off override of the draft-preview auto-approve timeout, overriding the `clarifier.draftTimeoutSeconds` overlay value for this run. Enforces the same `[10, 600]` range as the overlay splice; an out-of-range value (and `0`) is rejected at flag-parse time with `InvalidTimeoutValue` and the run halts before any agent fires. | No (the flag is parsed and range-checked, but clarification — and the timeout it governs — runs after `validateAll()`). |

## `install.sh` flags

| Flag | Owning spec | Effect |
|---|---|---|
| `--help` / `-h` | R2 | Print help, exit 0. |
| `--uninstall` | R2 | Reverse the install (remove symlinks + MCP config entry; leave filesystem zones intact). |
| `--no-claude-code` | R2 | Install in CI/headless environments that have Node + git but no Claude Code; `gan` CLI works, `/gan` skill is unavailable. |
| `--runs-dir=<path>` | F7 | Set the central run-data store root at install time (persisted to `~/.claude/gan/runs-data-dir` and granted in `~/.claude/settings.json`). Interactive installs prompt, defaulting to `~/.gan-runs-data`. Per-run override via `GAN_RUNS_DATA`. |
| `--module-state-dir=<path>` | F8 | Set the central module-state store root at install time (persisted to the marker `~/.claude/gan/module-state-dir`). Interactive installs prompt, defaulting to `~/.gan-module-state`. Per-run override via `GAN_MODULE_STATE`. Marker-only — unlike `--runs-dir`, it writes **no** `~/.claude/settings.json` grant (module state is config-server-managed). A separate root from `--runs-dir`. |

## `gan` CLI subcommands

| Subcommand | Owning spec | Effect |
|---|---|---|
| `gan validate` | R3 | Run `validateAll()` and print a report. |
| `gan config print` | R3 | Print the full resolved config (use `--json` for raw). |
| `gan config get <path>` | R3 | Print one resolved value at a dotted path. |
| `gan config set <path> <value>` | R3 | Update one splice point at the named tier. |
| `gan stacks list` | R3 | List active stacks with tier provenance. |
| `gan stacks new <name>` | R3 | Scaffold a stub stack file (DRAFT-bannered until user removes). |
| `gan stack show <name>` | R3 | Print one stack's full data. |
| `gan stack update <name> <field> <value>` | R3 | Update one field of a stack file. |
| `gan modules list` | R3 | List registered modules + `pairsWith` status. |
| `gan runs unlock` | O4 | Print the current run-lock holder (run id, pid, last trace-activity age, terminal status) and, on confirmation (`--yes` bypasses), remove the lock. Refuses without confirmation when the holder shows recent trace activity. The sanctioned escape for a wedged repo; replaces the retired `rm <lockPath>` instruction. Scope modifiers: `--run-id <id>`, `--project-root <path>`. |
| `gan hooks status` | H1 | Report the user-tier confinement hook + its authoring framework version, any project-tier override (which takes precedence), and a deletion hint when the override matches a known-legacy `.gan/` layout. |
| `gan trust info` | R5 | Show approval status + declared command-paths. Reminder that the trust hash does not transitively cover scripts. |
| `gan trust approve` | R5 | Approve the current content hash for the named project. Trust-mutating; `--project-root` required. |
| `gan trust revoke` | R5 | Remove approval for the named project. Trust-mutating; `--project-root` required. |
| `gan trust list` | R5 | List all current approvals. |
| `gan version` | R3 | Print API version, server version, schemas in use. |
| `gan help` / `gan --help` / `gan -h` | R3 | Print top-level help (one help surface; aliases for muscle-memory). |

## `gan` CLI flags

| Flag | Scope | Owning spec | Effect |
|---|---|---|---|
| `--help` / `-h` | every subcommand | R3 | Print subcommand help, exit 0. |
| `--json` | reads | R3 | Emit raw API JSON instead of human format. |
| `--project-root=<path>` | global | R3 | Project root override. Trust-mutating subcommands require this explicitly. |
| `--tier=project\|user` | `gan stacks new` | R3 | Scaffold target tier; default `project`. |
| `--note=<text>` | `gan trust approve` | R5 | Note attached to approval (free text; user-visible in `gan trust list`). |

## Environment variables

| Var | Values | Owning spec | Effect |
|---|---|---|---|
| `GAN_TRUST` | unset / `strict` / `unsafe-trust-all` | F4 | Trust mode. Unset = interactive prompt on `UntrustedOverlay`. `strict` = fail closed (no prompt; CI default). `unsafe-trust-all` = bypass trust check (development convenience; never in CI). |
| `GAN_RUNS_DATA` | absolute path | F7 | Per-run override of the central run-data store root. Highest-priority store-root source (above the install-time `~/.claude/gan/runs-data-dir` marker and the `~/.gan-runs-data` default). For testing and CI. |
| `GAN_MODULE_STATE` | absolute path | F8 | Per-run override of the central module-state store root. Highest-priority module-state-root source (above the install-time `~/.claude/gan/module-state-dir` marker and the `~/.gan-module-state` default). For testing and CI. |
| `GAN_WORKTREE` | absolute path | F7 | Orchestrator-exported absolute path to the resolved worktree (the user's worktree in case 1a, or `<project>/.gan-state/runs/<run-id>/worktree/` in 1b/1c). Consumed by the confinement hook as an allowed write zone. |
| `GAN_RUN_DIR` | absolute path | F7 | Orchestrator-exported absolute path to the central-store run directory (`<store-root>/<repo-key>/runs/<run-id>/`) holding the run artifacts, `trace/`, and `telemetry/`. Consumed by the confinement hook as an allowed write zone. |

## Trust prompt branches (interactive UI)

The trust prompt has one render with two content variants (subsequent-change vs. initial-introduction), four action branches:

| Branch | Action | Owning spec |
|---|---|---|
| `[v]` | View — diff for subsequent-change, command-list for initial-introduction. | F4 |
| `[a]` | Approve and run; writes `(projectRoot, contentHash)` to the trust cache. | F4 |
| `[r]` | Run with `--no-project-commands` (skip project-defined commands); does not write to cache. | F4 |
| `[c]` | Cancel; abort the run. | F4 |

## Clarifier draft-preview prompt branches (interactive UI)

The clarifier draft preview renders `clarified-spec.md` and then offers an action menu (`Proceed with this spec? [a]pprove / [e]dit / "evolve: <text>" / [c]ancel`, with `(auto-approve in 60s)`). The `[a]` / `[e]` / `[c]` keys are single-keystroke, case-insensitive; `evolve:` is a literal case-insensitive prefix followed by the evolution text. Four action branches:

| Branch | Action | Owning spec |
|---|---|---|
| `[a]` | Approve the draft as-is; proceed to the planner. | E5 |
| `[e]` | Edit — open `clarified-spec.md` in `$EDITOR` (→ `$VISUAL` → `vi`); on editor exit re-validate and re-present the menu. Does not consume an evolution round. | E5 |
| `evolve: <text>` | Evolve — re-run the clarifier with the original prompt + accumulated `additionalContext` + the evolution text; present a fresh draft. Consumes one of the (at most two) evolution rounds. | E5 |
| `[c]` | Cancel — abort with `UserCancelled` (Ctrl-C at the menu is treated identically). | E5 |

## Surface-count rule and inventory

**Rule.** Each unique `(surface-type, name)` pair counts once. Surface-type ∈ {command, subcommand, flag, env-var-value, prompt-branch}. Multi-word subcommands count as one (`gan trust approve` = one entry). Flags count by sigil string, deduplicated globally — `--help` appears under three commands but counts once. Aliases of the same flag (`--help` / `-h` / `help`) count as one surface, not three. Prompt branches count per unique action key, not per render variant.

**Post-trim inventory (current):**

| Surface-type | Count | Members |
|---|---|---|
| command | 3 | `/gan`, `gan`, `install.sh` |
| subcommand | 17 | `validate`, `config print`, `config get`, `config set`, `stacks list`, `stacks new`, `stack show`, `stack update`, `modules list`, `runs unlock`, `hooks status`, `trust info`, `trust approve`, `trust revoke`, `trust list`, `version`, `help` |
| flag | 25 | `--help`, `--print-config`, `--recover`, `--list-recoverable`, `--cleanup`, `--run-id`, `--all`, `--include-terminal`, `--yes`, `--no-project-commands`, `--no-telemetry`, `--skip-welcome`, `--new-worktree`, `--max-attempts`, `--reset-attempts`, `--skip-clarification`, `--clarifier-timeout`, `--uninstall`, `--no-claude-code`, `--runs-dir`, `--module-state-dir`, `--json`, `--project-root`, `--tier`, `--note` |
| env-var-value | 6 | `GAN_TRUST=strict`, `GAN_TRUST=unsafe-trust-all`, `GAN_RUNS_DATA`, `GAN_MODULE_STATE`, `GAN_WORKTREE`, `GAN_RUN_DIR` |
| prompt-branch | 8 | trust prompt: `[v]`, `[a]`, `[r]`, `[c]`; clarifier draft preview: `[a]`, `[e]`, `evolve:`, `[c]` |
| **total** | **59** | |

Pre-trim baseline was 43 (`gan trust export`/`import` and `gan migrate-overlays` as subcommands; `--out`, `--no-notes`, `--to`, `--force` as flags; `GAN_TRUST=approved-hashes-only` as env-var value). The trim removed exactly the 8 surfaces projected.

**On schema fields vs. counted surfaces (Q5).** Q5 adds two new optional **stack-schema fields** — `documentationSurfaces` (an array of documentation-standard surfaces instantiated as gating contract criteria) and `docLintCmd` (a deterministic baseline-relative doc-lint invocation). These are stack-file body fields, **not** runtime knobs: the surface-count rule above keys on `(surface-type, name)` where surface-type ∈ {command, subcommand, flag, env-var-value, prompt-branch}, and schema fields are none of those. Q5 introduces no new flag, env-var value, subcommand, command, or prompt branch (the spec says so explicitly). The inventory does not maintain a schema-field list, so there is nothing to add to the tables above; this note records that **Q5 changed no counted surface** — the total was **49** when Q5 landed (A1 and E5 have since raised it; see the running total in the inventory above).

When this table grows, the surface count grows with it. New knobs require explicit table editing as part of the PR; specs do not own surfaces independently. A1 added `--max-attempts` and `--reset-attempts` in its authoring PR (taking the total from 49 to 51). E5 has now landed `--skip-clarification` and `--clarifier-timeout` (two flags, 22 → 24) plus the four clarifier draft-preview prompt branches (`[a]` / `[e]` / `evolve:` / `[c]`, 4 → 8), taking the total from 51 to 57. O3 adds `--no-telemetry` (24 → 25 flags, 57 → 58). O4 adds the `gan runs unlock` subcommand (16 → 17 subcommands, 58 → 59); its `--yes` / `--run-id` / `--project-root` modifiers are existing counted sigils, so no flag count changes. Downstream releases will add surfaces here in their authoring PRs — anticipated additions include budget overrides (T3). As the header states, this is the **design** inventory: it includes the drafted-but-unmerged O-series entries (`--print-config` from O1; the `--recover` / `--list-recoverable` / `--cleanup` family from O2; `--no-telemetry` from O3), and the [roadmap](roadmap.md)'s implementation order — not this count — is authoritative for which have actually shipped.
