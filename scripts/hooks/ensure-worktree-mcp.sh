#!/usr/bin/env bash
#
# ensure-worktree-mcp.sh — Claude Code hook: keep the local-scope
# `claudeagents-config` MCP server pointed at THIS worktree's build.
#
# Wired from .claude/settings.json to two events:
#   * WorktreeCreate — fires when Claude Code creates a worktree.
#   * SessionStart   — fires every time a session starts in the worktree;
#     the catch-all for worktrees created outside Claude Code.
#
# WHY "ALWAYS RELINK" (not a per-worktree sentinel)
# -------------------------------------------------
# `claude mcp --scope local` keys its registration by the git *main*
# worktree path, so every linked worktree of one repo SHARES a single
# local-scope `claudeagents-config` entry. A per-worktree marker would
# let worktree A think "already linked" while the shared entry actually
# points at worktree B's build — A would silently run B's code with no
# warning. So this hook **always re-links** to the worktree the session
# opened (idempotent; `--no-build` when dist already exists). That
# guarantees the registration Claude Code uses for this session matches
# the worktree you are in.
#
# The reminder to restart is gated by a *repo-scoped* state file living
# in the git common dir (shared by every worktree of the repo, same
# scope as the registration itself). It records the dist the entry was
# last pointed at; the reminder fires only when this hook actually
# changed the target — i.e. exactly when the running stdio server is now
# stale and a restart is genuinely required. Reopening the same worktree
# repeatedly stays silent.
#
# DEVELOPER OPT-IN — this hook is committed (it travels with the repo so
# it reaches every dev worktree), so it MUST be inert on an end user's
# machine. The framework repo's own package.json IS
# @claudeagents/config-server, so the "is this a framework checkout?"
# guard cannot, alone, distinguish a developer's feature worktree from an
# end user who merely opened the source. The deciding signal is an
# explicit, per-machine opt-in that lives OUTSIDE the repo (so it can
# never be committed and an end user never has it):
#
#   * env  CLAUDEAGENTS_DEV=1                  (handy for CI / one-offs)
#   * file ~/.claude/claudeagents-dev          (persistent; covers every
#                                               worktree on this machine)
#
# Contract:
#   * Silent exit 0 unless the dev opt-in is present AND the directory is
#     a @claudeagents/config-server checkout — never interferes with
#     normal projects or end-user machines.
#   * Never blocks: a missing node_modules prints a one-line reminder
#     instead of running a multi-minute `npm install` inline.
#   * Always re-links (correctness); reminder is shown only when the
#     registration target actually changed (anti-spam, repo-scoped).
#   * Always exits 0 (advisory, never fails the session or the tool).
#
# The actual MCP (re)registration is delegated to the committed,
# idempotent scripts/dev-worktree-link.sh.

set -uo pipefail

# Consume stdin (hooks are fed JSON) without requiring it. WorktreeCreate
# may carry the new worktree path; parse defensively and fall back to the
# session's project dir so SessionStart always works regardless of the
# WorktreeCreate payload shape.
STDIN_JSON="$(cat 2>/dev/null || true)"

# --- developer opt-in gate: end-user machines have neither signal ------
DEV_MARKER="${HOME:-/nonexistent}/.claude/claudeagents-dev"
if [ "${CLAUDEAGENTS_DEV:-}" != "1" ] && [ ! -f "$DEV_MARKER" ]; then
  exit 0
fi

resolve_dir() {
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
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
    printf '%s\n' "$CLAUDE_PROJECT_DIR"
    return
  fi
  printf '%s\n' "$PWD"
}

DIR="$(resolve_dir)"
PKG="$DIR/package.json"
LINK_SCRIPT="$DIR/scripts/dev-worktree-link.sh"
DIST="$DIR/dist/config-server/index.js"

# --- no-op guards: must be a framework checkout with the dev script ---
[ -f "$PKG" ] || exit 0
grep -q '"name": *"@claudeagents/config-server"' "$PKG" 2>/dev/null || exit 0
[ -x "$LINK_SCRIPT" ] || exit 0

# --- dependencies absent: don't block; tell the user the one command ---
if [ ! -d "$DIR/node_modules" ]; then
  printf '%s\n' \
    "⟳ ClaudeAgents dev: $DIR has no node_modules — not linked." \
    "   Run:  scripts/dev-worktree-link.sh --install" \
    "   then RESTART Claude Code so the config server respawns here." >&2
  exit 0
fi

# --- repo-scoped state file (git common dir is shared by all worktrees,
#     matching the per-repo scope of the local MCP registration) -------
GCD="$(git -C "$DIR" rev-parse --git-common-dir 2>/dev/null || true)"
if [ -n "$GCD" ]; then
  case "$GCD" in
    /*) : ;;
    *)  GCD="$DIR/$GCD" ;;
  esac
  STATE_FILE="$GCD/claudeagents-mcp-link.state"
else
  # Not resolvable as a git dir (shouldn't happen for a checkout) —
  # degrade to a per-dir state file so we still avoid reminder spam.
  STATE_FILE="$DIR/.claudeagents-mcp-link.state"
fi
PREV="$(cat "$STATE_FILE" 2>/dev/null || true)"

# --- ALWAYS relink so the shared registration matches THIS worktree ---
LOG="${TMPDIR:-/tmp}/claudeagents-dev-link.log"
if [ -f "$DIST" ]; then
  ( cd "$DIR" && "$LINK_SCRIPT" --no-build ) >"$LOG" 2>&1 || true
else
  ( cd "$DIR" && "$LINK_SCRIPT" ) >"$LOG" 2>&1 || true
fi

# If the link did not produce the dist the entry points at, leave the
# state unchanged so the next session retries, and surface the failure.
if [ ! -f "$DIST" ]; then
  printf '%s\n' \
    "⟳ ClaudeAgents dev: link attempt did not produce $DIST" \
    "   (see link log: $LOG). The MCP server may be stale." >&2
  exit 0
fi

# Persist the repo-scoped target and remind ONLY when it changed — that
# is exactly when the already-spawned stdio server is now stale.
printf '%s' "$DIST" > "$STATE_FILE" 2>/dev/null || true
if [ "$PREV" != "$DIST" ]; then
  printf '%s\n' \
    "⟳ ClaudeAgents dev: the claudeagents-config MCP server now points at" \
    "   $DIR" \
    "   RESTART Claude Code — stdio MCP servers are spawned once at" \
    "   session start and do not hot-reload. Until you restart you are" \
    "   still talking to the previously-spawned server." \
    "   (link log: $LOG)" >&2
fi

exit 0
