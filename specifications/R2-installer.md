# R2 — Installer

**Status:** Stub. Drafted in Phase 2.

## Purpose

`install.sh` (or equivalent) bootstraps ClaudeAgents on a user's machine in one run. After successful execution and one Claude Code restart, `/gan` is fully operational.

## Anticipated content

- Prerequisite checks: Node 18+, git, Claude Code presence.
- Steps performed:
  1. Symlink agents and skills into the user's Claude Code config.
  2. Install the R1 MCP server (npm install -g or equivalent).
  3. Register the MCP server in Claude Code's config.
  4. Prepare filesystem zones (F1) for the current project if applicable.
  5. Run `validateAll()` against the user's config; abort install on validation failure.
- Friction acknowledged: one Claude Code restart is required after install for the MCP server to be loaded. First `/gan` invocation may show a one-time MCP permission prompt.
- Idempotency: running `install.sh` twice is safe; second run upgrades or no-ops.
- Uninstaller: `install.sh --uninstall` reverses the install cleanly.

## Dependencies

- F1 (zones to prepare)
- F2 (API contract — installer verifies the server implements it)
- R1 (MCP server to install)

## Bite-size note

Sprintable as: skeleton install.sh → MCP registration → zone preparation → uninstall logic → idempotency tests.
