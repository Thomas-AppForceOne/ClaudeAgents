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
# No-op in the globally-linked checkout
# -------------------------------------
# If you run this in the very checkout that `install.sh` global-linked,
# the user-scope entry's bin already resolves (through the npm global-link
# symlink chain) to THIS worktree's `dist/config-server/index.js` — the
# exact file a local-scope entry would run. Adding a local entry there
# changes nothing about which code executes; it only makes the two scopes
# disagree on the literal command string, which is what trips
# `claude doctor`'s "Conflicting scopes" warning. So in that case the
# script detects the match, clears any stale local entry, and skips the
# link — running it there is a no-op by design.
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

# Canonicalise a path, fully resolving every symlink in the chain. Used to
# tell whether the global install's bin already resolves to THIS worktree's
# dist entry. Node is always present in a config-server checkout and its
# realpath resolves the npm global-link chain (`/opt/homebrew/bin/...` ->
# package symlink -> repo `dist/...`) reliably across platforms — BSD
# `readlink` lacks `-f` on older macOS. Prints nothing if the path is
# missing or cannot be resolved.
realpath_of() {
  node -e 'process.stdout.write(require("fs").realpathSync(process.argv[1]))' "$1" 2>/dev/null
}

# Echoes the canonical target of the globally-linked config-server bin when
# it resolves to THIS worktree's dist entry (i.e. `install.sh` global-linked
# this very checkout), and nothing otherwise. In that state a local-scope
# MCP entry would point at the same file as the existing user-scope one,
# adding nothing but a spurious "Conflicting scopes" warning from
# `claude doctor`.
global_points_here() {
  local bin target dist
  bin="$(command -v claudeagents-config-server 2>/dev/null || true)"
  [ -n "$bin" ] || return 0
  # `|| true` keeps a failed resolve (missing/unreadable path) from tripping
  # `set -e`; an empty target simply means "no match", handled below.
  target="$(realpath_of "$bin")" || true
  dist="$(realpath_of "$DIST_ENTRY")" || true
  if [ -n "$target" ] && [ "$target" = "$dist" ]; then
    printf '%s' "$target"
  fi
}

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
      sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
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
      if status_target="$(global_points_here)"; [ -n "$status_target" ]; then
        info "global   : points at THIS worktree ($(command -v claudeagents-config-server))"
        info "           -> linking is a no-op here; the user-scope entry already"
        info "              runs this dist. A local-scope entry would only trigger"
        info "              claude doctor's 'Conflicting scopes' warning. Use"
        info "              --unlink to clear any stale local entry."
      else
        info "global   : points elsewhere — a local-scope link shadows it here."
      fi
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

    # If `install.sh` global-linked THIS checkout, the user-scope entry
    # already resolves to $DIST_ENTRY — the exact file a local-scope entry
    # would run. Registering local scope then adds nothing but a spurious
    # "Conflicting scopes" warning from `claude doctor`. Detect that, drop
    # any stale local entry from a previous run, and skip the add: linking
    # the globally-linked checkout is a no-op by design.
    if global_target="$(global_points_here)"; [ -n "$global_target" ]; then
      info "global install already points at this worktree:"
      info "  $(command -v claudeagents-config-server) -> $global_target"
      info ""
      info "A local-scope entry would duplicate the existing user-scope one"
      info "and trigger claude doctor's 'Conflicting scopes' warning, so no"
      info "local link is needed here."
      if mcp_in_worktree remove "$SERVER_NAME" --scope local >/dev/null 2>&1; then
        info ""
        info "Removed a stale local-scope '$SERVER_NAME' entry left by an"
        info "earlier run. RESTART Claude Code so it falls back to the global"
        info "install."
      fi
      info ""
      info "(If you later install.sh a DIFFERENT checkout, re-run this script"
      info " here to restore the local link.)"
      exit 0
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
