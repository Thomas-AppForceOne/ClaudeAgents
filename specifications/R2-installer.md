# R2 — Installer

## Problem

ClaudeAgents has many moving parts: agents, skills, the Configuration MCP server (R1), CLI (R3), filesystem zones (F1), Claude Code config integration. A user dropping into the framework should not have to assemble these pieces by hand. The installer's job is one-script setup so the user runs one command, restarts Claude Code once, and `/gan` works.

## Proposed change

`install.sh` at the repo root. Bash 3.2-compatible (the macOS system default; avoids bash-4 features like associative arrays, `mapfile`, and `${var,,}`/`${var^^}` case-folding parameter expansion). POSIX-compatible. Idempotent. Reversible via `install.sh --uninstall`.

The bash-3.2 floor follows the v1 platform priority documented in `PROJECT_CONTEXT.md` ("Platform priority"): macOS is the v1 release-gate platform, so the system bash version on stock macOS is the binding floor. Modern Linux bash is a strict superset and runs the script unchanged; Windows is explicitly out-of-scope for v1. The existing `install.sh` already conforms to the bash-3.2 floor — calling it out here is documentation discipline, not a code change.

**Retirement.** The existing 138-line `install.sh` (old `.gan/`-based installer that links agents and skills without an MCP server) is rewritten in place when R2 is implemented. Same path, full content replacement. The implementation PR's diff shows a single `M` (modified) entry on `install.sh`; there is no transition period where both installers exist. See the roadmap's Retirement table.

The rewritten installer makes a particular point of cleanup: any pre-existing `.gan/` directory at the user's project root is named in the post-install message as a hand-delete target (per F1's hard-error policy), and any pre-existing symlinks pointing at the old `agents/*.md` files (which E1 retires) are explicitly verified-and-pruned during install, not silently re-linked.

**Feature-branch mid-state is non-functional by design.** R2 lands in Phase 2; E1's prompt rewrites land in Phase 3. A developer checking out `feature/stack-plugin-rfc` between R2's land and E1's land and running `./install.sh` would symlink agent prompts that are about to be rewritten — the resulting install would mix the new MCP-server-aware orchestrator with the old hardcoded prompts. **This is not a supported state.** Production use stays on `main`, which carries the pre-pivot architecture intact until the post-E1 break merges Phase 3 to main as a unit. Internal feature-branch developers running `./install.sh` mid-Phase-2 should expect a half-system; the branch is for spec implementation, not daily use.

### Responsibilities

1. **Prerequisite checks.** Verify Node 20.10+ and git are installed. By default also verify Claude Code is installed; bail with a clear actionable error on each missing prerequisite (include the install command for that platform). Pass `--no-claude-code` to skip the Claude Code check — used by CI runners and headless environments that consume the MCP server / `gan` CLI directly without going through Claude Code.
2. **Symlink agents and skills.** Link `agents/*.md` and `skills/gan/` into the user's Claude Code config directory. Use symlinks so updates to the repo are reflected immediately.
3. **Install the MCP server (R1).** Run `npm install -g @claudeagents/config-server` (pinned to the version this repo declares in a `MCP_SERVER_VERSION` constant). Until `@claudeagents/config-server` is published to a public registry, `install.sh` instead runs `npm install -g .` from the repo root (the **local-install-only rule** documented in `PROJECT_CONTEXT.md`); the published-registry path lights up automatically once the package is released.
4. **Create the built-in stacks symlink** at `~/.claude/gan/builtin-stacks/` pointing at `<packageRoot>/stacks/` (where `<packageRoot>` is `<npm-root-g>/@claudeagents/config-server`). The symlink is a user-tier convenience handle for browsing the framework's canonical stack files; the resolver itself reaches `<packageRoot>` directly via `import.meta.url` and does not depend on this symlink. Idempotent: a re-run that finds the same symlink already pointing at the right target is a no-op; a stale symlink pointing somewhere else is replaced atomically (`ln -sfn`); a real file or directory at the link path is left alone with a warning. Skipped on Windows shells (MSYS / Cygwin / MinGW). Best-effort: a missing `npm root -g` resolution or absent `<packageRoot>/stacks/` directory logs a warning and continues. Recorded in STATE_LOG so partial-failure rollback can undo it; removed by `--uninstall` only when the symlink still points into the framework install (user-redirected symlinks are left alone).
5. **Register the MCP server in Claude Code's config.** Append a `claudeagents-config` entry to the user's MCP config (typically `~/.claude.json` or the path Claude Code's docs name). Idempotent: re-running detects an existing entry and updates the version pin without duplicating.
6. **Prepare filesystem zones for the current project (if `install.sh` is run inside a git repo).** Create `.gan-state/` and `.gan-cache/` and add them to `.gitignore` if not already present. `.claude/gan/` is left alone (created lazily when the user first authors an overlay).
7. **Run `validateAll()` against the current project.** A first sanity check; reports any pre-existing config issues. A failure here is a warning, not an installer abort, since the project may legitimately have no overlays yet.
8. **Print a final status block.** "ClaudeAgents installed. Restart Claude Code once; on first `/gan` invocation, approve the MCP server when prompted. After that, you're ready."

### Friction profile

The user accepts:

- One Claude Code restart after `install.sh` finishes (Claude Code loads the new MCP server entry on launch).
- One MCP-server permission prompt on the first `/gan` invocation after install (Claude Code's standard security flow for newly-registered servers).

Both are one-time. Subsequent runs are friction-free.

### Idempotency

Running `install.sh` twice in a row is safe. The second run:

- Re-verifies prerequisites.
- Re-applies symlinks (no-op if already present).
- Updates the MCP server version pin if it changed in the repo.
- Validates the existing project config.
- Reports "already installed (versions match)" or "upgraded from <old> to <new>".

### Help text

`install.sh --help` (and `-h`) prints to stdout and exits 0:

- One-line description of what the installer does.
- The flag list with one-line descriptions: `--uninstall`, `--no-claude-code`, `--help`.
- A summary of what the installer creates and where (symlinks, MCP config entry, project filesystem zones).
- Prerequisites the installer expects (Node 20.10+, git; Claude Code unless `--no-claude-code`).
- The exit-code convention (0 success, non-zero on any failure with a named cause).
- A pointer to the project README for fuller documentation.

Bare `install.sh` runs the install (this is the primary verb and changing it would break muscle memory). Unknown flags exit non-zero with a one-line error and a pointer to `--help`. Help text is for users; it never references maintainer-only scripts.

### Uninstall

`install.sh --uninstall` reverses the install:

- Removes the agent and skill symlinks.
- Removes the MCP server entry from Claude Code's config (does not uninstall the npm package, since other tools may depend on it).
- Removes the `~/.claude/gan/builtin-stacks/` symlink **only when** it still points into the globally-installed framework package (`<npm-root-g>/@claudeagents/config-server/...`). User-redirected symlinks are left alone with a warning so a deliberate user override is never silently destroyed.
- Leaves filesystem zones intact (they contain user state; the user opts in to their removal).
- Prints the equivalent npm and rm commands needed to clean up further if desired.

### Failure handling

Any failure halts the installer with a non-zero exit code, an error message naming what failed, and a remediation hint. The installer never leaves the system in a half-installed state: each step is gated on the previous step's success, and a step that creates state (npm install, MCP config edit) is reversed before exit if a later step in the same install phase fails.

### What the installer does not do

- It does not modify the user's shell profile (no PATH edits beyond what npm-global already provides).
- It does not install Node, git, or Claude Code. Those are prerequisites the user manages.
- It does not configure project-specific overlays. `.claude/gan/project.md` is the user's deliberate authoring step.

## Acceptance criteria

- A clean machine with prerequisites installed reaches "ready to run `/gan` after one Claude Code restart" with one execution of `install.sh`.
- `install.sh` exits non-zero with a clear message when any prerequisite is missing, naming the prerequisite and an install hint.
- `install.sh --no-claude-code` succeeds on a CI runner that has Node and git but no Claude Code; the resulting install lets `gan validate` and other CLI commands run, but `/gan` is not available (no Claude Code to host the skill).
- Running `install.sh` twice does not duplicate MCP config entries, does not create duplicate symlinks, and does not reinstall an already-current npm package.
- `install.sh --uninstall` removes the symlinks and MCP config entry; subsequent `/gan` invocations report "ClaudeAgents not installed".
- A failure mid-install (simulated by killing the npm step) leaves the system either fully pre-install or fully post-install, never half-configured.
- The installer does not touch `.claude/gan/`, `.gan-state/runs/`, or any user data not created by itself.
- `install.sh --help` and `install.sh -h` print the help text to stdout and exit 0; the text lists every flag, the prerequisites, and a summary of what the installer creates. Unknown flags exit non-zero with a pointer to `--help`.
- After a clean install, `~/.claude/gan/builtin-stacks/` exists as a symlink pointing at `<npm-root-g>/@claudeagents/config-server/stacks/`. A re-run produces the same symlink with no errors and no duplicate STATE_LOG entries. A pre-existing real file or directory at the link path is left intact with a warning. The Windows-shell case (MSYS / Cygwin / MinGW) skips the step silently. `install.sh --uninstall` removes the symlink only when it still points into the framework install; user-redirected symlinks survive uninstall.

## Dependencies

- F1 (zones to prepare)
- F2 (API contract — installer's `validateAll()` call uses this)
- R1 (MCP server to install)

## Bite-size note

Sprintable as: prerequisite checks → symlink logic → npm install → Claude Code config edit → zone preparation → validation call → uninstall path → idempotency tests.
