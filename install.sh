#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

UNINSTALL=0
NO_CLAUDE_CODE=0

print_help() {
  cat <<'HELP'
install.sh — install ClaudeAgents (the framework) into your environment.

Usage:
  install.sh [flags]

Flags:
  --help, -h          Show this help and exit.
  --uninstall         Reverse a previous install (remove symlinks and the
                      Claude Code MCP entry; user data is left intact).
  --no-claude-code    Skip the Claude Code prerequisite check. Use on CI
                      runners or headless environments that consume the
                      framework's CLI directly without Claude Code hosting it.

What it does:
  - Symlinks ClaudeAgents agents and skills into your Claude Code config
    directory (typically ~/.claude/).
  - Installs the ClaudeAgents config server into your global node toolchain
    so Claude Code can register it as an MCP server.
  - Registers the MCP server entry in your Claude Code config.
  - Prepares per-project filesystem zones (.gan-state/ and .gan-cache/)
    when run inside a git repository.

Prerequisites:
  - Node 20.10 or newer (Node 22 is supported; Node 23+ is not).
    macOS: brew install node@20
    Other: see https://nodejs.org/
  - git on PATH.
  - Claude Code installed and on PATH (skip with --no-claude-code).

Exit codes:
  0  Success.
  Non-zero on any failure; the message names what failed and how to fix it.

For more, see the project README.
HELP
}

err() {
  printf '%s\n' "$*" >&2
}

platform_install_hint() {
  local tool="$1"
  case "$(uname -s)" in
    Darwin)
      case "$tool" in
        node) echo "macOS: brew install node@20 (or see https://nodejs.org/)" ;;
        git) echo "macOS: brew install git (or install Xcode Command Line Tools: xcode-select --install)" ;;
        claude) echo "macOS: install Claude Code from https://claude.com/claude-code" ;;
      esac
      ;;
    Linux)
      case "$tool" in
        node) echo "Linux: install Node 20 LTS via nvm or your package manager (see https://nodejs.org/)" ;;
        git) echo "Linux: install via your package manager (e.g. apt-get install git, dnf install git)" ;;
        claude) echo "Linux: install Claude Code from https://claude.com/claude-code" ;;
      esac
      ;;
    *)
      case "$tool" in
        node) echo "See https://nodejs.org/ for install instructions." ;;
        git) echo "Install git from https://git-scm.com/." ;;
        claude) echo "Install Claude Code from https://claude.com/claude-code" ;;
      esac
      ;;
  esac
}

parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --help|-h)
        print_help
        exit 0
        ;;
      --uninstall)
        UNINSTALL=1
        ;;
      --no-claude-code)
        NO_CLAUDE_CODE=1
        ;;
      *)
        err "install.sh: unknown flag: $1"
        err "Run 'install.sh --help' for usage."
        exit 2
        ;;
    esac
    shift
  done
}

# Compare two dotted version strings. Echo -1 if $1 < $2, 0 if equal, 1 if greater.
version_compare() {
  local a="$1"
  local b="$2"
  local ai bi
  local IFS=.
  # shellcheck disable=SC2206
  local aparts=($a)
  # shellcheck disable=SC2206
  local bparts=($b)
  local i=0
  local max=${#aparts[@]}
  if [ "${#bparts[@]}" -gt "$max" ]; then
    max=${#bparts[@]}
  fi
  while [ "$i" -lt "$max" ]; do
    ai="${aparts[$i]:-0}"
    bi="${bparts[$i]:-0}"
    if [ "$ai" -lt "$bi" ]; then
      echo -1
      return
    fi
    if [ "$ai" -gt "$bi" ]; then
      echo 1
      return
    fi
    i=$((i + 1))
  done
  echo 0
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    err "Node is not on PATH. ClaudeAgents requires Node 20.10 or newer."
    err "Install hint: $(platform_install_hint node)"
    exit 1
  fi
  local raw
  raw="$(node --version 2>/dev/null || true)"
  local stripped="${raw#v}"
  if [ -z "$stripped" ]; then
    err "Could not read Node version (got: '$raw'). ClaudeAgents requires Node 20.10 or newer."
    err "Install hint: $(platform_install_hint node)"
    exit 1
  fi
  local cmp_min cmp_max
  cmp_min=$(version_compare "$stripped" "20.10.0")
  cmp_max=$(version_compare "$stripped" "23.0.0")
  if [ "$cmp_min" = "-1" ] || [ "$cmp_max" != "-1" ]; then
    err "Node $stripped is not supported. ClaudeAgents requires Node >=20.10.0 and <23."
    err "Install hint: $(platform_install_hint node)"
    exit 1
  fi
}

check_git() {
  if ! command -v git >/dev/null 2>&1; then
    err "git is not on PATH. ClaudeAgents needs git to manage repository zones."
    err "Install hint: $(platform_install_hint git)"
    exit 1
  fi
}

check_claude() {
  if [ "$NO_CLAUDE_CODE" = "1" ]; then
    return 0
  fi
  if ! command -v claude >/dev/null 2>&1; then
    err "Claude Code (the 'claude' command) is not on PATH."
    err "Install hint: $(platform_install_hint claude)"
    err "Re-run with --no-claude-code if you intend to use the framework without Claude Code."
    exit 1
  fi
}

feature_branch_warning() {
  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi
  local branch
  branch="$(cd "$REPO_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ "$branch" = "feature/stack-plugin-rfc" ]; then
    err "Warning: you are on branch 'feature/stack-plugin-rfc'. This branch is non-functional"
    err "by design — it carries mid-pivot work that is not a supported install state."
    err "Production users should stay on 'main' until the pivot lands."
  fi
}

run_install() {
  echo "ClaudeAgents installer skeleton: prerequisites verified."
  echo "(Install body lands in a later sprint; no filesystem changes were made.)"
}

run_uninstall() {
  echo "ClaudeAgents uninstaller skeleton: prerequisites verified."
  echo "(Uninstall body lands in a later sprint; no filesystem changes were made.)"
}

main() {
  parse_args "$@"

  check_node
  check_git
  check_claude

  feature_branch_warning

  if [ "$UNINSTALL" = "1" ]; then
    run_uninstall
  else
    run_install
  fi
}

main "$@"
