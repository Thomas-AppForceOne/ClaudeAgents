#!/usr/bin/env bash
# ClaudeAgents installer — R2 sprints 1 + 2.
#
# S1 landed the side-effect-free outer shell: argv parsing, help text, and
# prerequisite checks. S2 lands the happy-path install body: symlinks,
# `npm install -g .`, `~/.claude.json` registration, zone preparation,
# and a best-effort post-install validate. Rollback machinery and the
# `--uninstall` body land in S3.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
CLAUDE_HOME="$HOME/.claude"
CLAUDE_CONFIG_JSON="$HOME/.claude.json"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=10
MAX_NODE_MAJOR=22

# STATE_LOG — append-only audit trail of state-creating steps. S3 will
# consume this for rollback; S2 only writes to it. Each entry is a single
# line of the form `<kind>:<absolute-path>` so a future rollback can scan
# it without parsing structured data.
STATE_LOG=()

# Flag set by detect_preexisting_gan_dir; consumed by print_final_status.
PREEXISTING_GAN_DIR=""

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

# ---------------------------------------------------------------------------
# S2 — happy-path install
# ---------------------------------------------------------------------------

# prune_stale_agent_symlinks
#
# Walks `$CLAUDE_HOME/agents/` and `$CLAUDE_HOME/skills/` only. Removes
# any symlink whose target no longer exists (broken / dangling).
# Idempotent on a clean machine — the loops simply find nothing to do.
# Strictly scoped to `$CLAUDE_HOME` (= `$HOME/.claude`); the repo's own
# `skills/` directory is never touched here, even if it contains a
# broken symlink (e.g. the legacy `skills/gan/gan` leftover, which is an
# E1 retirement target, not an installer responsibility).
prune_stale_agent_symlinks() {
  local dir entry
  for dir in "$CLAUDE_HOME/agents" "$CLAUDE_HOME/skills"; do
    [ -d "$dir" ] || continue
    # Use a glob that includes hidden entries; `nullglob` keeps the loop
    # silent when the directory is empty.
    shopt -s nullglob dotglob
    for entry in "$dir"/*; do
      if [ -L "$entry" ] && [ ! -e "$entry" ]; then
        rm -f "$entry"
        STATE_LOG+=("pruned-symlink:$entry")
      fi
    done
    shopt -u nullglob dotglob
  done
}

# link_agents_and_skills
#
# Creates `$CLAUDE_HOME/agents/<name>.md` symlinks pointing at
# `$REPO_ROOT/agents/<name>.md`, and a single `$CLAUDE_HOME/skills/gan`
# symlink pointing at `$REPO_ROOT/skills/gan`. Uses `ln -sfn` so a
# re-run replaces the link in place (idempotent).
link_agents_and_skills() {
  mkdir -p "$CLAUDE_HOME/agents"
  mkdir -p "$CLAUDE_HOME/skills"

  local f name target
  shopt -s nullglob
  for f in "$REPO_ROOT/agents/"*.md; do
    name="$(basename "$f")"
    target="$CLAUDE_HOME/agents/$name"
    ln -sfn "$f" "$target"
    STATE_LOG+=("symlink:$target")
  done
  shopt -u nullglob

  if [ -d "$REPO_ROOT/skills/gan" ]; then
    target="$CLAUDE_HOME/skills/gan"
    ln -sfn "$REPO_ROOT/skills/gan" "$target"
    STATE_LOG+=("symlink:$target")
  fi
}

# version_probe_mcp
#
# Prints the installed config-server's reported version (without leading
# `v`) on stdout, or empty if the binary is missing or fails. Never
# exits non-zero; callers compare the result against the package.json
# version to decide whether to (re)install.
version_probe_mcp() {
  if ! command -v claudeagents-config-server >/dev/null 2>&1; then
    printf ''
    return 0
  fi
  local out
  out="$(claudeagents-config-server --version 2>/dev/null || true)"
  # Strip trailing newline / whitespace and a leading `v` if present.
  out="${out%%$'\n'*}"
  out="${out## }"
  out="${out%% }"
  printf '%s' "${out#v}"
}

# install_mcp_server
#
# Runs `npm install -g .` from `$REPO_ROOT`. Captures combined output to
# a discardable variable; on failure dies with framework prose
# (CC-PROSE compliant) and the literal retry command in backticks. The
# captured package-manager output is *not* echoed back to the user
# because raw package-manager prose can leak prohibited prose tokens
# through the F4 boundary (the user re-runs the retry command in
# backticks to see the real underlying error).
install_mcp_server() {
  local out
  if ! out="$(cd "$REPO_ROOT" && npm install -g . 2>&1)"; then
    : "captured but suppressed: $out"
    log_error "ClaudeAgents installer: failed to install the framework's config server."
    die "Re-run \`npm install -g .\` from $REPO_ROOT to see the underlying error."
  fi
  STATE_LOG+=("npm-installed:$REPO_ROOT")
}

# backup_claude_json_once
#
# Copies `$CLAUDE_CONFIG_JSON` to `~/.claude.json.backup-<timestamp>`
# the first time `install.sh` is run on this machine. A subsequent run
# detects an existing backup via a glob test and is a no-op. Single
# backup per machine, never per run.
backup_claude_json_once() {
  [ -f "$CLAUDE_CONFIG_JSON" ] || return 0

  local existing
  shopt -s nullglob
  existing=("$HOME"/.claude.json.backup-*)
  shopt -u nullglob
  if [ "${#existing[@]}" -gt 0 ]; then
    return 0
  fi

  local stamp dest
  stamp="$(date +%Y%m%d%H%M%S)"
  dest="$HOME/.claude.json.backup-$stamp"
  cp "$CLAUDE_CONFIG_JSON" "$dest"
  STATE_LOG+=("backup:$dest")
}

# register_mcp_in_claude_json
#
# Sets `mcpServers.claudeagents-config = {command, args, env}` on
# `~/.claude.json`. Reads the existing JSON (or starts from `{}` when
# the file is absent), edits via `node -e` (no JSON-CLI dependency),
# writes the result to a `*.tmp.$$` sibling with sorted keys +
# 2-space indent + trailing newline, then `mv`s atomically into place.
# Idempotent on re-run.
register_mcp_in_claude_json() {
  local tmp="$CLAUDE_CONFIG_JSON.tmp.$$"
  CLAUDE_CONFIG_JSON_PATH="$CLAUDE_CONFIG_JSON" \
  CLAUDE_CONFIG_TMP_PATH="$tmp" \
  node -e '
    const fs = require("fs");
    const src = process.env.CLAUDE_CONFIG_JSON_PATH;
    const dst = process.env.CLAUDE_CONFIG_TMP_PATH;
    let data = {};
    if (fs.existsSync(src)) {
      const raw = fs.readFileSync(src, "utf8");
      if (raw.trim().length > 0) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error("install.sh: ~/.claude.json is not valid JSON: " + e.message);
          process.exit(1);
        }
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          console.error("install.sh: ~/.claude.json must be a JSON object.");
          process.exit(1);
        }
      }
    }
    if (typeof data.mcpServers !== "object" || data.mcpServers === null || Array.isArray(data.mcpServers)) {
      data.mcpServers = {};
    }
    data.mcpServers["claudeagents-config"] = {
      command: "claudeagents-config-server",
      args: [],
      env: {},
    };
    function sortedStringify(value, indent) {
      const sortKeys = (v) => {
        if (Array.isArray(v)) return v.map(sortKeys);
        if (v && typeof v === "object") {
          const out = {};
          for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
          return out;
        }
        return v;
      };
      return JSON.stringify(sortKeys(value), null, indent);
    }
    const out = sortedStringify(data, 2) + "\n";
    fs.writeFileSync(dst, out, "utf8");
  '
  mv "$tmp" "$CLAUDE_CONFIG_JSON"
  STATE_LOG+=("claude-json:$CLAUDE_CONFIG_JSON")
}

# detect_preexisting_gan_dir
#
# When the cwd is a git repo and `<repo-top>/.gan/` exists, set
# PREEXISTING_GAN_DIR so the final-status block can name it as a
# hand-delete target. Not a hard abort.
detect_preexisting_gan_dir() {
  PREEXISTING_GAN_DIR=""
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || return 0
  if [ -d "$top/.gan" ]; then
    PREEXISTING_GAN_DIR="$top/.gan"
  fi
}

# prepare_zones
#
# Inside a git repo only: creates zone-2 (`.gan-state/`) and zone-3
# (`.gan-cache/`) directories at the repo top, and appends them to
# `.gitignore` if not already listed. Zone 1 (`.claude/gan/`) is left
# alone (created lazily on first overlay authoring).
prepare_zones() {
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || return 0

  mkdir -p "$top/.gan-state" "$top/.gan-cache"
  STATE_LOG+=("zone-dir:$top/.gan-state")
  STATE_LOG+=("zone-dir:$top/.gan-cache")

  local gi="$top/.gitignore"
  # Ensure file exists so `grep -Fxq` has something to read; the grep
  # itself succeeds against a missing file with `|| true`, but creating
  # the file once keeps the append idempotent in either case.
  [ -f "$gi" ] || : >"$gi"
  local entry
  for entry in ".gan-state/" ".gan-cache/"; do
    if ! grep -Fxq "$entry" "$gi"; then
      printf '%s\n' "$entry" >>"$gi"
      STATE_LOG+=("gitignore-entry:$gi:$entry")
    fi
  done
}

# run_validate_all_best_effort
#
# Inside a git repo only: invokes the framework's validate path. On any
# nonzero exit, logs a warning and returns 0 — validate is not a gate
# for the install, just a heads-up that overlays / stack files have
# pre-existing issues. Skipped entirely when not in a git repo.
run_validate_all_best_effort() {
  local top
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || return 0

  if ! command -v claudeagents-config-server >/dev/null 2>&1; then
    log_warn "ClaudeAgents installer: skipping post-install validate (the framework's config server is not on PATH)."
    return 0
  fi

  if ! claudeagents-config-server --validate-all >/dev/null 2>&1; then
    log_warn "ClaudeAgents installer: post-install validate reported issues. Run \`claudeagents-config-server --validate-all\` for details."
  fi
}

# print_final_status
#
# Emits the post-install status block. Names the zones, mentions the
# `~/.claude.json` registration, and (when detected) flags a
# pre-existing `.gan/` directory as a hand-delete target. Feature-branch
# warning lives in S3.
print_final_status() {
  log_info ""
  log_info "ClaudeAgents installer: install complete."
  log_info "  - Agent and skill links written under $CLAUDE_HOME/."
  log_info "  - Claude Code registration written to $CLAUDE_CONFIG_JSON (skipped under --no-claude-code)."
  log_info "  - Repository zones \`.gan-state/\` and \`.gan-cache/\` prepared (when run inside a git repo)."

  if [ -n "$PREEXISTING_GAN_DIR" ]; then
    log_info ""
    log_info "Heads up: a legacy \`.gan/\` directory exists at $PREEXISTING_GAN_DIR."
    log_info "Delete it by hand once you have copied anything you still need: \`rm -rf $PREEXISTING_GAN_DIR\`."
  fi

  log_info ""
  log_info "Restart Claude Code to pick up the new agents, skills, and config server."
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

  # Read the package.json version once; the version-probe compares
  # against this when deciding whether to run `npm install -g .`.
  local package_version probe_version
  package_version="$(read_mcp_server_version)"

  prune_stale_agent_symlinks
  link_agents_and_skills

  probe_version="$(version_probe_mcp)"
  if [ -z "$probe_version" ] || [ "$probe_version" != "$package_version" ]; then
    install_mcp_server
  fi

  if [ "$skip_claude_code" -eq 0 ]; then
    backup_claude_json_once
    register_mcp_in_claude_json
  fi

  detect_preexisting_gan_dir
  prepare_zones
  run_validate_all_best_effort
  print_final_status
  exit 0
}

main "$@"
