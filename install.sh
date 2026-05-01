#!/usr/bin/env bash
# ClaudeAgents installer — R2 sprint 1 skeleton.
#
# This sprint lands the side-effect-free outer shell: argv parsing, help
# text, and prerequisite checks. The install body (symlinks, npm install,
# `~/.claude.json` registration, zone preparation) lands in S2; the
# uninstall body and rollback lands in S3.
#
# Re-running this skeleton makes no filesystem changes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
CLAUDE_HOME="$HOME/.claude"
CLAUDE_CONFIG_JSON="$HOME/.claude.json"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=10
MAX_NODE_MAJOR=22

log_info() {
  printf '%s\n' "$*"
}

log_warn() {
  printf 'warning: %s\n' "$*" >&2
}

log_error() {
  printf 'error: %s\n' "$*" >&2
}

die() {
  log_error "$*"
  exit 1
}

print_help() {
  cat <<'HELP'
install.sh — install ClaudeAgents (the framework) into your environment.

Usage:
  install.sh [flags]

Flags:
  --help, -h          Show this help and exit.
  --uninstall         Reverse a previous install (remove symlinks and the
                      Claude Code config entry; user data is left intact).
  --no-claude-code    Skip the Claude Code prerequisite check. Use on CI
                      runners or headless environments that consume the
                      framework directly without Claude Code hosting it.

What it does:
  - Symlinks ClaudeAgents agents and skills into your Claude Code config
    directory (typically `~/.claude/`).
  - Installs the framework's config server globally so Claude Code can
    register it.
  - Registers the config-server entry in your Claude Code config
    (`~/.claude.json`).
  - Prepares per-project filesystem zones (`.gan-state/` and `.gan-cache/`)
    when run inside a git repository.

Prerequisites:
  - `node` `20.10` or newer on PATH (`node` `22` LTS is supported; `node` `23`
    and newer is not). Install via your package manager (for example
    `brew install` on macOS, or `nvm` on Linux). See https://nodejs.org/ for
    full instructions.
  - `git` on PATH.
  - Claude Code installed and on PATH (skip with --no-claude-code).

Exit codes:
  0  Success.
  Non-zero on any failure; the message names what failed and how to fix it.

For more, see the project README.
HELP
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node is not on PATH. ClaudeAgents requires Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer (and Node <=${MAX_NODE_MAJOR}). See https://nodejs.org/."
  fi

  local raw stripped
  raw="$(node --version 2>/dev/null || true)"
  stripped="${raw#v}"
  if [ -z "$stripped" ]; then
    die "Could not read Node version (got: '$raw'). ClaudeAgents requires Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer."
  fi

  local major minor
  major="${stripped%%.*}"
  local rest="${stripped#*.}"
  minor="${rest%%.*}"

  case "$major" in
    ''|*[!0-9]*)
      die "Could not parse Node major version (got: '$raw'). ClaudeAgents requires Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer."
      ;;
  esac
  case "$minor" in
    ''|*[!0-9]*)
      minor=0
      ;;
  esac

  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "Node $stripped is too old. ClaudeAgents requires Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer."
  fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; then
    die "Node $stripped is too old. ClaudeAgents requires Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer."
  fi
  if [ "$major" -gt "$MAX_NODE_MAJOR" ]; then
    die "Node $stripped is newer than ClaudeAgents supports. The supported range is Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} through Node ${MAX_NODE_MAJOR}.x."
  fi
}

check_git() {
  if ! command -v git >/dev/null 2>&1; then
    die "\`git\` is not on PATH. ClaudeAgents needs \`git\` to manage repository zones. Install via your package manager (e.g. \`brew install git\` on macOS, \`apt-get install git\` on Debian / Ubuntu)."
  fi
}

check_claude_code() {
  if ! command -v claude >/dev/null 2>&1; then
    die "Claude Code (the \`claude\` command) is not on PATH. Install Claude Code from https://claude.com/claude-code, or re-run with --no-claude-code if you intend to use the framework without it."
  fi
}

read_mcp_server_version() {
  node -p "require('$REPO_ROOT/package.json').version"
}

main() {
  local mode="install"
  local skip_claude_code=0

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h)
        print_help
        exit 0
        ;;
      --uninstall)
        mode="uninstall"
        ;;
      --no-claude-code)
        skip_claude_code=1
        ;;
      *)
        log_error "install.sh: unknown flag: $1"
        log_error "Run \`install.sh --help\` for usage."
        exit 2
        ;;
    esac
    shift
  done

  if [ "$mode" = "uninstall" ]; then
    log_info "uninstall lands in S3; no filesystem changes were made."
    exit 0
  fi

  check_node
  check_git
  if [ "$skip_claude_code" -eq 0 ]; then
    check_claude_code
  fi

  log_info "ClaudeAgents installer: prerequisites verified."
  log_info "skeleton-only (install path lands in S2); no filesystem changes were made."
  exit 0
}

main "$@"
