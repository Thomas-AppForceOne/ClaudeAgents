#!/usr/bin/env bash
#
# ensure-worktree-mcp.sh — Claude Code hook: keep the local-scope
# `claudeagents-config` MCP server pointed at THIS worktree's build.
#
# Wired from .claude/settings.json to two events:
#   * WorktreeCreate — fires when Claude Code creates a worktree; links
#     the new worktree immediately.
#   * SessionStart   — catch-all self-heal for worktrees created outside
#     Claude Code (e.g. `git worktree add` in a terminal). Links on the
#     first session in an unlinked worktree, then stays quiet.
#
# Contract (per the update-config skill flow):
#   * Silent exit 0 for any directory that is not a @claudeagents/
#     config-server checkout — never interferes with normal projects.
#   * Never blocks: a missing node_modules prints a one-line reminder
#     instead of running a multi-minute `npm install` inline.
#   * Idempotent + non-spammy: once a worktree is linked, a per-worktree
#     marker (node_modules/.claudeagents-mcp-linked, which is gitignored
#     via node_modules) suppresses the reminder on subsequent sessions.
#   * Always exits 0 (advisory, never fails the session or the tool).
#
# The actual MCP (re)registration is delegated to the committed,
# idempotent scripts/dev-worktree-link.sh.

set -uo pipefail

# Consume stdin (hooks are fed JSON) without requiring it. WorktreeCreate
# may carry the new worktree path; we parse defensively and fall back to
# the session's project dir so SessionStart always works even if the
# WorktreeCreate payload shape differs.
STDIN_JSON="$(cat 2>/dev/null || true)"

resolve_dir() {
  # 1. A path field in the hook payload (WorktreeCreate).
  if [ -n "$STDIN_JSON" ] && command -v jq >/dev/null 2>&1; then
    local p
    p="$(printf '%s' "$STDIN_JSON" | jq -r '
      .worktree_path // .worktreePath // .path // .worktree.path //
      .new_worktree // .destination // .cwd // empty' 2>/dev/null || true)"
    if [ -n "$p" ] && [ -d "$p" ]; then
      printf '%s\n' "$p"
      return
    fi
  fi
  # 2. Claude Code sets CLAUDE_PROJECT_DIR for hooks.
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
    printf '%s\n' "$CLAUDE_PROJECT_DIR"
    return
  fi
  # 3. Last resort: current directory.
  printf '%s\n' "$PWD"
}

DIR="$(resolve_dir)"
PKG="$DIR/package.json"
LINK_SCRIPT="$DIR/scripts/dev-worktree-link.sh"
DIST="$DIR/dist/config-server/index.js"
MARKER="$DIR/node_modules/.claudeagents-mcp-linked"

# --- no-op guards: must be a framework checkout with the dev script ---
[ -f "$PKG" ] || exit 0
grep -q '"name": *"@claudeagents/config-server"' "$PKG" 2>/dev/null || exit 0
[ -x "$LINK_SCRIPT" ] || exit 0

# --- anti-spam: already linked to THIS worktree's dist? stay silent ---
if [ -f "$MARKER" ] && [ "$(cat "$MARKER" 2>/dev/null || true)" = "$DIST" ]; then
  exit 0
fi

# --- dependencies absent: don't block; tell the user the one command ---
if [ ! -d "$DIR/node_modules" ]; then
  printf '%s\n' \
    "⟳ ClaudeAgents dev: $DIR is not linked and has no node_modules." \
    "   Run:  scripts/dev-worktree-link.sh --install" \
    "   then RESTART Claude Code so the config server respawns here." >&2
  exit 0
fi

# --- (re)link this worktree, delegating to the idempotent dev script ---
LOG="${TMPDIR:-/tmp}/claudeagents-dev-link.log"
if [ -f "$DIST" ]; then
  # dist already built — fast path, just re-register the MCP entry.
  ( cd "$DIR" && "$LINK_SCRIPT" --no-build ) >"$LOG" 2>&1 || true
else
  # deps present but no build yet — let the dev script build then link.
  ( cd "$DIR" && "$LINK_SCRIPT" ) >"$LOG" 2>&1 || true
fi

# Record the marker only if the link script actually produced the dist
# the MCP entry now points at; otherwise leave it unmarked so the next
# session retries.
if [ -f "$DIST" ]; then
  mkdir -p "$DIR/node_modules" 2>/dev/null || true
  printf '%s' "$DIST" > "$MARKER" 2>/dev/null || true
fi

printf '%s\n' \
  "⟳ ClaudeAgents dev: linked the MCP config server to this worktree" \
  "   ($DIR)." \
  "   RESTART Claude Code now — stdio MCP servers are spawned once at" \
  "   session start and do not hot-reload. Until you restart you are" \
  "   still talking to the previously-spawned server." \
  "   (link log: $LOG)" >&2

exit 0
