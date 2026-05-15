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
# DEVELOPER OPT-IN — this hook is committed (it travels with the repo so
# it reaches every dev worktree), so it MUST be inert on an end user's
# machine. The framework repo's own package.json IS
# @claudeagents/config-server, so the "is this a framework checkout?"
# guard below is true for the repo itself and cannot, on its own,
# distinguish a developer's feature worktree from an end user who merely
# opened the source. The deciding signal is an explicit, per-machine
# opt-in that lives OUTSIDE the repo (so it can never be committed and an
# end user never has it):
#
#   * env  CLAUDEAGENTS_DEV=1                  (handy for CI / one-offs)
#   * file ~/.claude/claudeagents-dev          (persistent; covers every
#                                               worktree on this machine)
#
# Absent both, this script exits 0 immediately and does NOTHING. End
# users — who never create that marker — get the one global install,
# project-independent, exactly as intended. A framework developer opts
# the machine in once and every worktree auto-links thereafter.
#
# Contract (per the update-config skill flow):
#   * Silent exit 0 unless the dev opt-in is present AND the directory is
#     a @claudeagents/config-server checkout — never interferes with
#     normal projects or end-user machines.
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

# --- developer opt-in gate: end-user machines have neither signal ------
DEV_MARKER="${HOME:-/nonexistent}/.claude/claudeagents-dev"
if [ "${CLAUDEAGENTS_DEV:-}" != "1" ] && [ ! -f "$DEV_MARKER" ]; then
  exit 0
fi

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
