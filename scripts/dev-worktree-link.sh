#!/usr/bin/env bash
#
# dev-worktree-link.sh — point Claude Code's `claudeagents-config` MCP
# server at THIS worktree's build, for framework developers.
#
# Why this exists
# ---------------
# `install.sh` global-links the config server (`npm install -g .`) and
# registers ONE user-scope MCP entry in `~/.claude.json`. That is correct
# for end users: one install, project-independent. But on a framework
# developer's machine it means every worktree is silently shadowed by
# whichever checkout was last `install.sh`'d — you can edit and rebuild a
# feature worktree all day and Claude Code still runs the global build.
#
# This script registers a *local-scope* `claudeagents-config` MCP server
# keyed to this worktree's directory. Claude Code MCP precedence is
# local > project > user, so within this worktree the local entry shadows
# the global one; every other project keeps using the global install.
# End users never run this script, so their single-install behaviour is
# untouched.
#
# Run it once per worktree, any time after you create the worktree (and
# again whenever you want to be sure the registration is current — it is
# idempotent).
#
# Usage
# -----
#   scripts/dev-worktree-link.sh            # build + (re)link this worktree
#   scripts/dev-worktree-link.sh --no-build # link without rebuilding dist
#   scripts/dev-worktree-link.sh --install  # npm install, then build + link
#   scripts/dev-worktree-link.sh --status   # show current registration
#   scripts/dev-worktree-link.sh --unlink   # remove the local-scope entry
#
# After linking (or unlinking) you MUST restart Claude Code: stdio MCP
# servers are long-lived subprocesses spawned at session start and do not
# hot-reload.

set -euo pipefail

readonly SERVER_NAME="claudeagents-config"
readonly EXPECTED_PKG="@claudeagents/config-server"

err()  { printf 'dev-worktree-link: %s\n' "$*" >&2; }
info() { printf 'dev-worktree-link: %s\n' "$*"; }

# Resolve the worktree root. `git rev-parse --show-toplevel` returns the
# *worktree's* root inside a linked worktree (not the main checkout),
# which is exactly what we want to key the local-scope entry to.
if ! WORKTREE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  err "not inside a git repository. Run this from within a framework worktree."
  exit 1
fi

# Confirm this really is a config-server checkout before we touch any
# Claude Code config — refuse to mislink a random repo.
PKG_JSON="$WORKTREE_ROOT/package.json"
if [ ! -f "$PKG_JSON" ]; then
  err "no package.json at $WORKTREE_ROOT — not a framework checkout."
  exit 1
fi
if ! grep -q "\"name\": *\"$EXPECTED_PKG\"" "$PKG_JSON"; then
  err "package.json at $WORKTREE_ROOT is not '$EXPECTED_PKG'."
  err "This script only links a ClaudeAgents config-server checkout."
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  err "the 'claude' CLI is not on PATH; cannot manage MCP registration."
  exit 1
fi

readonly DIST_ENTRY="$WORKTREE_ROOT/dist/config-server/index.js"
readonly BRANCH="$(git -C "$WORKTREE_ROOT" branch --show-current 2>/dev/null || echo '(detached)')"

mode="link"
do_build=1
do_install=0
for arg in "$@"; do
  case "$arg" in
    --status)  mode="status" ;;
    --unlink)  mode="unlink" ;;
    --no-build) do_build=0 ;;
    --install)  do_install=1 ;;
    -h|--help)
      sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      err "unknown argument '$arg' (see --help)."
      exit 1
      ;;
  esac
done

# `claude mcp` local scope is keyed to the directory the command runs in,
# so every invocation below is wrapped in a subshell that cd's to the
# worktree root. Running the script from a subdirectory still works.
mcp_in_worktree() { ( cd "$WORKTREE_ROOT" && claude mcp "$@" ); }

case "$mode" in
  status)
    info "worktree : $WORKTREE_ROOT"
    info "branch   : $BRANCH"
    if [ -f "$DIST_ENTRY" ]; then
      info "dist     : present ($DIST_ENTRY)"
    else
      info "dist     : MISSING — run without --status to build it"
    fi
    info "registered MCP servers for this directory:"
    mcp_in_worktree list 2>/dev/null | sed 's/^/  /' || info "  (claude mcp list failed)"
    info "Restart Claude Code after any change for it to take effect."
    exit 0
    ;;

  unlink)
    # `remove` without an explicit scope removes from whichever scope it
    # is found in; pin to local so we never delete the global user entry.
    if mcp_in_worktree remove "$SERVER_NAME" --scope local >/dev/null 2>&1; then
      info "removed local-scope '$SERVER_NAME' for $WORKTREE_ROOT"
    else
      info "no local-scope '$SERVER_NAME' was registered for $WORKTREE_ROOT (nothing to do)"
    fi
    info "RESTART Claude Code so it falls back to the global install."
    exit 0
    ;;

  link)
    if [ "$do_install" -eq 1 ]; then
      info "running 'npm install' in $WORKTREE_ROOT ..."
      ( cd "$WORKTREE_ROOT" && npm install )
    fi

    if [ "$do_build" -eq 1 ]; then
      if [ ! -d "$WORKTREE_ROOT/node_modules" ]; then
        err "node_modules is missing. Re-run with --install (or 'npm install' first)."
        exit 1
      fi
      info "building dist (npm run build) ..."
      ( cd "$WORKTREE_ROOT" && npm run build )
    fi

    if [ ! -f "$DIST_ENTRY" ]; then
      err "build entry not found: $DIST_ENTRY"
      err "Run without --no-build, or 'npm run build' manually, then retry."
      exit 1
    fi

    # Idempotent: drop any existing local-scope entry first so a re-run
    # always reflects the current path. Ignore failure (none registered).
    mcp_in_worktree remove "$SERVER_NAME" --scope local >/dev/null 2>&1 || true

    # `--` separates the server command from claude's own flags.
    mcp_in_worktree add "$SERVER_NAME" --scope local -- node "$DIST_ENTRY"

    info ""
    info "linked '$SERVER_NAME' (local scope) -> node $DIST_ENTRY"
    info "  worktree : $WORKTREE_ROOT"
    info "  branch   : $BRANCH"
    info ""
    info "NEXT: restart Claude Code. stdio MCP servers are spawned once at"
    info "session start and do NOT hot-reload — until you restart, you are"
    info "still talking to the previously-spawned server."
    info ""
    info "Verify after restart: call getResolvedConfig on any project and"
    info "confirm the resolved paths name this worktree, or 'scripts/"
    info "dev-worktree-link.sh --status'."
    exit 0
    ;;
esac
