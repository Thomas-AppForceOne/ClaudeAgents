# ClaudeAgents — Runtime knobs

Single inventory of every flag, env-var value, and prompt branch a user can hit at runtime. Authoritative — individual specs reference this table rather than restating their own surfaces. New knobs land here in the same PR that adds them.

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
| `--recover` | O2 | Resume a previously-aborted run. Mechanism prescriptively authored at the post-E1 break. | No (validateAll runs in non-aborting mode). |
| `--list-recoverable` | O2 | List archived recoverable runs; exit. | No (validateAll runs in non-aborting mode). |
| `--no-project-commands` | F4 | Run with all project-declared commands suppressed. Recommended when reviewing someone else's branch. | No. |

## `install.sh` flags

| Flag | Owning spec | Effect |
|---|---|---|
| `--help` / `-h` | R2 | Print help, exit 0. |
| `--uninstall` | R2 | Reverse the install (remove symlinks + MCP config entry; leave filesystem zones intact). |
| `--no-claude-code` | R2 | Install in CI/headless environments that have Node + git but no Claude Code; `gan` CLI works, `/gan` skill is unavailable. |

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
| `--tier=project\|repo` | `gan stacks new` | R3 | Scaffold target tier; default `project`. |
| `--note=<text>` | `gan trust approve` | R5 | Note attached to approval (free text; user-visible in `gan trust list`). |

## Environment variables

| Var | Values | Owning spec | Effect |
|---|---|---|---|
| `GAN_TRUST` | unset / `strict` / `unsafe-trust-all` | F4 | Trust mode. Unset = interactive prompt on `UntrustedOverlay`. `strict` = fail closed (no prompt; CI default). `unsafe-trust-all` = bypass trust check (development convenience; never in CI). |

## Trust prompt branches (interactive UI)

The trust prompt has one render with two content variants (subsequent-change vs. initial-introduction), four action branches:

| Branch | Action | Owning spec |
|---|---|---|
| `[v]` | View — diff for subsequent-change, command-list for initial-introduction. | F4 |
| `[a]` | Approve and run; writes `(projectRoot, contentHash)` to the trust cache. | F4 |
| `[r]` | Run with `--no-project-commands` (skip project-defined commands); does not write to cache. | F4 |
| `[c]` | Cancel; abort the run. | F4 |

## Surface-count rule and inventory

**Rule.** Each unique `(surface-type, name)` pair counts once. Surface-type ∈ {command, subcommand, flag, env-var-value, prompt-branch}. Multi-word subcommands count as one (`gan trust approve` = one entry). Flags count by sigil string, deduplicated globally — `--help` appears under three commands but counts once. Aliases of the same flag (`--help` / `-h` / `help`) count as one surface, not three. Prompt branches count per unique action key, not per render variant.

**Post-trim inventory (current):**

| Surface-type | Count | Members |
|---|---|---|
| command | 3 | `/gan`, `gan`, `install.sh` |
| subcommand | 15 | `validate`, `config print`, `config get`, `config set`, `stacks list`, `stacks new`, `stack show`, `stack update`, `modules list`, `trust info`, `trust approve`, `trust revoke`, `trust list`, `version`, `help` |
| flag | 11 | `--help`, `--print-config`, `--recover`, `--list-recoverable`, `--no-project-commands`, `--uninstall`, `--no-claude-code`, `--json`, `--project-root`, `--tier`, `--note` |
| env-var-value | 2 | `GAN_TRUST=strict`, `GAN_TRUST=unsafe-trust-all` |
| prompt-branch | 4 | `[v]`, `[a]`, `[r]`, `[c]` |
| **total** | **35** | |

Pre-trim baseline was 43 (`gan trust export`/`import` and `gan migrate-overlays` as subcommands; `--out`, `--no-notes`, `--to`, `--force` as flags; `GAN_TRUST=approved-hashes-only` as env-var value). The trim removed exactly the 8 surfaces projected.

When this table grows, the surface count grows with it. New knobs require explicit table editing as part of the PR; specs do not own surfaces independently. The v1.0 specs (A1, T1, E5) and downstream releases will add surfaces here in their authoring PRs — anticipated additions include `--skip-clarification` (E5), trace-related read paths (T1), and budget overrides (T3), but the table remains authoritative only for surfaces whose owning spec has landed.
