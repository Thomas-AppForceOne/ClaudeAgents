# I2 — Install user-facing surfaces

## Problem

I1 makes the install pipeline correct (the bin works, the source repo can be moved). But correctness is necessary, not sufficient. The first dogfooding session surfaced three user-facing gaps that produced abandoned sessions even after the install technically succeeded:

1. **No path forward after install.** `install.sh`'s success message said "Restart Claude Code to pick up the new agents, skills, and config server." A user who restarted then had no idea how to verify the install — the message did not name `/gan --help` or any other discoverability hook. They were one step removed from "is this thing working?" and "how do I run it?"

2. **No first-run orientation.** The first time a user invokes `/gan` after install, they may face up to three unfamiliar surfaces in sequence: a Claude Code permission prompt for the framework's MCP tools, the framework's own trust prompt for project-tier overlays, and the clarifier draft preview (E5). Each surface is documented in its own spec but new users encounter them cold. The first invocation feels intrusive when each surface is unprefaced.

3. **Permission-prompt friction during sprints.** Claude Code's per-call MCP permission prompts fire on every framework MCP call unless the user has pre-approved them in `~/.claude/settings.json`. The framework ships a recommended allowlist at `templates/claude-settings.json`, but the user has to discover it, copy it, and merge it manually. The first dogfooding session hit a permission prompt every few seconds during the early `/gan --print-config` exploration — loud enough to derail the session.

I2 covers the install pipeline's user-facing surfaces: the post-install message that orients the user toward `/gan --help`, the first-run welcome banner that previews what the framework will do, and the permission-allowlist consent flow that handles Claude Code permissions up-front instead of one-by-one mid-sprint.

I2 is the second spec under the **I** (install / installer) phase code. I1 (correctness) lands first; I2 builds on I1's working install and shapes how the user encounters the framework.

## Proposed change

### Post-install message: name the next step

`install.sh`'s success message gains a second line after the existing restart prompt:

```
Restart Claude Code to pick up the new agents, skills, and config server.
After restart, type `/gan --help` in any project to get started.
```

The `/gan --help` hook is significant because it short-circuits before validation (per E1 / SKILL.md). A user who completes the install but has nothing else configured can run `/gan --help` and get oriented without first authoring an overlay or running a sprint. The hint replaces the dead-end at "Restart Claude Code" with a concrete first command.

### First-run welcome banner

The first time `/gan` is invoked **as a regular sprint invocation** (not a short-circuit like `--help`, `--print-config`, `--list-recoverable`, `--recover`), the orchestrator presents a multi-paragraph welcome banner before running the user's actual command, then proceeds with the requested action. The banner is informational, not gating — no input is awaited, no confirmation required.

**The short-circuit exemption matters.** A user running `/gan --help` for orientation should see help text, not a banner. A user running `/gan --print-config` to debug a configuration is not in a "what is this thing?" state — they're already debugging and need the print output, not orientation. The banner fires only when the orchestrator is about to spawn agents; it does not fire when the orchestrator is about to short-circuit.

**Marker file at `~/.claude/gan/welcomed`.** The orchestrator checks for this file at startup. If absent, the banner is presented and the marker is created. If present, the banner is skipped. The marker is a zero-byte sentinel — its existence is the signal. Marker is written **after** the banner finishes printing but **before** downstream agents fire — Ctrl-C during the banner display does not write the marker, so the user gets a re-show on next run. A user who wants to re-read the banner can `rm ~/.claude/gan/welcomed`; a user who wants to skip on first run can pass `--skip-welcome` (the marker is written without the banner being printed).

**Banner content** introduces the user to:

- What ClaudeAgents is and what `/gan` does.
- The pipeline shape (clarifier → planner → contract → generator → evaluator), so the user knows what the agents are doing during a sprint.
- What Claude Code's trust prompts look like and when they appear (the framework triggers them when the project overlay declares commands).
- What the clarifier draft preview looks like and what its action menu offers ([a]pprove / [e]dit / `evolve: <text>` / [c]ancel + 60s timeout). Sets expectations for the first sprint's interactive moment.
- What `.gan-state/` accumulates as runs accrue (so the user is not surprised by a growing zone-2 directory).
- When to use `--no-project-commands` (e.g. reviewing someone else's branch — the framework does not run that branch's overlay-declared commands).
- Where to find docs (the README link).
- That the `gan` CLI exists for config inspection (`gan config print`, `gan stacks list`, etc.) alongside `/gan` for sprints — two entry points, two purposes.
- The `--help` discoverability hook for both `/gan` and `gan`.

The banner explicitly previews the trust prompt and clarifier-draft surfaces so a new user is not surprised when those fire during the first sprint. The trust prompt's "this is unfamiliar" feeling on first use is the largest UX risk in the v1.0 plan; the banner mitigates it by naming the prompt before it appears.

After the banner, the user's command proceeds without waiting for input — the banner is informational, not gating. On a non-TTY invocation (CI, automated scripts), the banner is skipped silently and the marker is created.

**`--skip-welcome` flag** is added to `/gan` and registered in [runtime-knobs.md](runtime-knobs.md). Idempotent — passing it on an already-welcomed system is a no-op, not an error. Use case: scripted invocations that don't want even the informational banner output.

### Permission-allowlist consent flow during install

After prerequisite checks complete, `install.sh` runs a `configure_permissions` step. This is an interactive 8-category prompt where the user approves or declines each category of operations the framework needs during sprints. Approved categories merge into `~/.claude/settings.json` `permissions.allow`; declined categories trigger Claude Code's per-call prompt at sprint time instead.

**The eight categories:**

| # | Category | Tools / commands | Required? |
|---|---|---|---|
| 1 | Framework MCP server | `mcp__claudeagents-config__*` | Yes — declining aborts install |
| 2 | File operations | `Read`, `Write`, `Edit`, `Glob`, `Grep` | No — recommended |
| 3 | Sub-agents | `Agent`, `TodoWrite` | No — recommended |
| 4 | Git read | `Bash(git status:*)`, `git diff:*`, `git log:*`, `git show:*`, `git branch:*`, `git rev-parse:*`, `git worktree list:*` | No — recommended |
| 5 | Git write | `Bash(git add:*)`, `git commit:*`, `git checkout:*`, `git worktree add:*`, `git worktree remove:*`, `git worktree prune:*` | No — recommended |
| 6 | Build & test | `Bash(npm test:*)`, `npm run:*`, `npm audit:*` | No — recommended |
| 7 | Dependency install | `Bash(npm install:*)` | No — some users prefer manual approval |
| 8 | Filesystem helpers | `Bash(ls:*)`, `cat:*`, `mkdir:*`, `realpath:*`, `test:*`, `echo:*` | No — recommended |

**Prompt UX:**

```
ClaudeAgents installer: configuring Claude Code permissions for /gan runs.

Each category below corresponds to operations the framework needs during a
sprint. Approving up-front means the operation runs without prompting mid-
sprint. Declining means Claude Code will prompt for each call (loud, but
you get full per-call review).

Press [a] to approve all remaining, [s] to skip all remaining, or [v] to
view the exact tools/commands a category covers before deciding.

[1/8] Framework MCP server  (mcp__claudeagents-config__*)
      Required for /gan to function at all. Declining here aborts install.
      Approve? [Y/n]

[2/8] File operations  (Read, Write, Edit, Glob, Grep)
      Approve? [Y/n/v]

...
```

**Default response is `[Y]`** — recommends approval. The `[v]` option expands the category, prints the literal `permissions.allow` entries that would be added, then re-prompts for the same category. The `[a]` shortcut auto-approves all remaining categories (single-keypress speed-through for users who trust the defaults). The `[s]` shortcut skips all remaining (only the framework MCP entry from #1 is added if the user already approved it).

**Non-TTY behavior.** When `[ -t 0 ]` is false (CI, scripted invocations), the prompt is suppressed. The default in non-TTY mode is **minimal**: only category 1 (Framework MCP) is added. Everything else stays unset; the user can re-run `install.sh` interactively to add categories, or hand-edit `~/.claude/settings.json`.

**Override flags** for non-interactive contexts:

- `--approve-all-permissions` — categories 1–8 are approved without prompting. Useful for CI runners that test the framework end-to-end.
- `--minimal-permissions` — only category 1 is approved. Useful for users who want strict per-call review and don't want the prompt sequence.
- `--reconfigure-permissions` — re-runs the prompt sequence even when categories are already granted. Useful when the user wants to revoke a previously-approved category.

The flags are mutually exclusive at the install-script level — passing both `--approve-all-permissions` and `--minimal-permissions` rejects with a structured error.

**Idempotency.** Re-running `install.sh` re-prompts only for categories not already in `permissions.allow`. Already-granted categories are silently skipped (one log line: "permission category 'Build & test' already granted; skipping."). With `--reconfigure-permissions`, every category re-prompts regardless of state.

**Atomic write to `~/.claude/settings.json`.** The merge uses the same temp-file + rename + sorted-key JSON pattern already used for `register_mcp_in_claude_json` in I3. Failure mid-write rolls back via the existing STATE_LOG mechanism (a new `claude-settings-edited` STATE_LOG entry covers the merge).

**Surgical entries.** Each approved category writes a fixed set of entries identified by the category's template. Uninstall (per I3) removes only the entries the framework added — entries the user added by hand, or entries from prior framework versions whose templates have changed, are left alone.

### What I2 does not do

- Auto-merge the broader `templates/claude-settings.json` allowlist (which adds opinionated per-tool entries beyond the eight framework categories). That template stays as an opt-in copy/merge step the user does explicitly. I2's eight categories are the framework's MINIMUM allowlist; users who want broader pre-approval copy from the template.
- Cover the post-install Claude Code restart UX. The restart is a Claude Code-level concern, not a framework concern. The framework names the restart in the success message; what Claude Code does on restart is its own.
- Address the trust prompt's wording or branching (covered by F4 / R5).
- Address what happens when an approved category's template changes between framework versions. The first-pass policy is "treat the user's existing entries as authoritative; do not overwrite." Future framework versions that need new entries within an existing category surface the additions as a re-prompt opportunity via `--reconfigure-permissions`.
- Provide a rollback for the welcome banner. Once the banner is shown, removing the marker re-shows it; that is the only mechanism. There is no "show me the banner again on every run" option (it would be visual noise).

## Field encodings

I2 introduces three new schema-bearing surfaces:

- **`~/.claude/gan/welcomed`** — zero-byte sentinel file. No structured content; presence is the signal. Per F1's zone-1 ownership rules, this lives under `~/.claude/gan/` (zone 1, configuration tier). Created by the orchestrator (not `install.sh`) when the banner is first shown.
- **`~/.claude/settings.json` `permissions.allow` entries** — JSON strings matching Claude Code's permission-pattern syntax (e.g. `"mcp__claudeagents-config__*"`, `"Bash(git status:*)"`). The framework treats these as opaque strings; their semantics are Claude Code's contract.
- **STATE_LOG entry** `claude-settings-edited:<preedit-path>` — added to install.sh's STATE_LOG schema. Same pattern as the existing `claude-json-edited:<preedit-path>` entry; rollback restores from the preedit copy.

The runtime-knob inventory in [runtime-knobs.md](runtime-knobs.md) gains four new flags:

- `--skip-welcome` (on `/gan`)
- `--approve-all-permissions` (on `install.sh`)
- `--minimal-permissions` (on `install.sh`)
- `--reconfigure-permissions` (on `install.sh`)

## Examples

A new user's first install — interactive TTY, accepting defaults:

```
$ ./install.sh
ClaudeAgents installer: prerequisites verified.
ClaudeAgents installer: configuring Claude Code permissions for /gan runs.

[1/8] Framework MCP server  (mcp__claudeagents-config__*)
      Required for /gan to function at all. Declining here aborts install.
      Approve? [Y/n] <Enter>

[2/8] File operations  (Read, Write, Edit, Glob, Grep)
      Approve? [Y/n/v] a

ClaudeAgents installer: install complete.
  - Agent and skill files copied under /Users/taa/.claude/.
  - Config server installed and verified on PATH.
  - Permissions allowlist updated (8/8 categories approved).
  - Claude Code registration written to /Users/taa/.claude.json.
  - Repository zones `.gan-state/` and `.gan-cache/` prepared.
  - Built-in stacks linked at /Users/taa/.claude/gan/builtin-stacks/.

Restart Claude Code to pick up the new agents, skills, and config server.
After restart, type `/gan --help` in any project to get started.
```

The same user's first `/gan "small change"` invocation — sees the welcome banner, then the rest of the flow:

```
$ /gan "small change"
ClaudeAgents — first run on this installation.

What this is: an adversarial development loop. Your prompt becomes a sprint
plan. Agents propose a contract, generate code, and evaluate it. The result
is reviewed before it lands.

The pipeline:
  clarifier → planner → contract → generator → evaluator

A few things you'll see during sprints:

  • Trust prompts. The first time you run /gan in a project that declares
    commands in its overlay (e.g. .claude/gan/project.md), the framework
    asks you to approve those commands. View the diff with [v], approve
    with [a], or run without project commands using [r].

  • Clarifier draft preview. After your prompt, the clarifier proposes a
    sprint spec and asks you to approve, edit, evolve, or cancel. Default
    is auto-approve in 60 seconds.

  • Per-run state under .gan-state/. Each /gan run gets a directory; the
    trace, intermediate artifacts, and recovery state live there.

  • `--no-project-commands` for review work. When auditing someone else's
    branch, run `/gan --no-project-commands` to skip the project's own
    commands.

For docs: README.md in the framework repo, or `/gan --help` and
`gan --help` for command-specific output.

Skip this banner next time? It won't show again unless you delete
~/.claude/gan/welcomed. To skip on the next run, pass --skip-welcome.

──────────────────────────────────────────────────────────────────

[normal /gan output begins here]
```

## Acceptance criteria

### Automated checks

- After `./install.sh` completes (TTY, all categories approved), `~/.claude/settings.json` `permissions.allow` contains all eight category templates' entries.
- After `./install.sh` completes (TTY, only `[a]` typed at category 2), categories 1–2 are added; categories 3–8 are not.
- After `./install.sh` completes (TTY, `[s]` typed at category 2), only category 1 is added; the install completes successfully.
- After `./install.sh` completes (TTY, `[n]` typed at category 1), the install aborts with a structured error naming the framework MCP requirement.
- `./install.sh --approve-all-permissions` (non-TTY) adds all eight category entries without prompting.
- `./install.sh --minimal-permissions` (non-TTY) adds only category 1.
- `./install.sh --approve-all-permissions --minimal-permissions` rejects with a "mutually exclusive" structured error.
- `./install.sh --reconfigure-permissions` re-prompts every category even when entries are already present.
- `./install.sh --uninstall` removes only the entries matching the framework's category templates; user-authored entries in `permissions.allow` are left intact.
- The post-install success message contains both the restart hint and the `/gan --help` hint.
- The first regular `/gan` invocation after install (no `--skip-welcome`, marker absent) prints the welcome banner before agent spawn.
- The first `/gan --help` invocation after install does NOT print the welcome banner.
- The first `/gan --print-config` after install does NOT print the welcome banner.
- The first `/gan` invocation passing `--skip-welcome` writes the marker without printing the banner.
- The second regular `/gan` invocation after the first (marker now present) does NOT print the banner.
- A regular `/gan` invocation killed via Ctrl-C during the banner display leaves the marker absent; the next invocation shows the banner again.

### Manual review checks

- The welcome banner content names every surface the user will encounter (trust prompt, clarifier draft preview, run state, `--no-project-commands`).
- The banner content follows the user-facing-discipline rule (no bare `npm`/`node`/`Node`/`MCP server` outside backticks).
- The 8-category prompt's [v] expansion produces output a user can act on (the literal allow-list entries, not just the category description).
- The post-install message's `/gan --help` hint is plain prose, not a maintainer-only script reference.

## Dependencies

- **I1** — self-contained install correctness; I2 builds on a working install pipeline.
- **F1** — zone semantics; the welcomed marker lives under `~/.claude/gan/` per zone-1 ownership.
- **F4** — trust prompt context that the welcome banner previews.
- **R2** — the installer spec; I2 amends R2 to include the configure-permissions step and the welcome-banner orchestrator hook.
- **E1** — the orchestrator that detects the welcomed marker and prints the banner.
- **runtime-knobs.md** — four new flags registered.

## Bite-size note

Sprintable as:

1. (one sprint) Post-install message update: add the `/gan --help` hint line. Tiny, lands first.
2. (one sprint) Welcome banner: marker file detection, banner content, short-circuit exemption (only fires on regular sprint invocations), `--skip-welcome` flag, runtime-knobs.md update.
3. (two sprints) Permission consent flow: 8-category prompt UX, [a]/[s]/[v] shortcuts, atomic merge into `~/.claude/settings.json`, STATE_LOG integration, rollback support, four new install.sh flags. Heaviest slice; warrants splitting into "prompt UX + atomic write" and "flags + idempotency + uninstall integration."
4. (one sprint) Test coverage: install round-trip with various consent paths, banner appearance/skip cases, marker creation timing, settings.json merge correctness.

Slices 1–3 must land in order; slice 4 depends on all three.
