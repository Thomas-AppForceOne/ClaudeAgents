#!/usr/bin/env bash
# ClaudeAgents installer — R2 sprints 1 + 2 + 3.
#
# S1 landed the side-effect-free outer shell: argv parsing, help text, and
# prerequisite checks. S2 lands the happy-path install body: symlinks,
# `npm install -g .`, `~/.claude.json` registration, zone preparation,
# and a best-effort post-install validate. S3 lands rollback on partial
# failure, the `--uninstall` mode, and the feature-branch mid-pivot
# warning.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
CLAUDE_HOME="$HOME/.claude"
CLAUDE_CONFIG_JSON="$HOME/.claude.json"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=10
MAX_NODE_MAJOR=22

# STATE_LOG — append-only audit trail of state-creating steps. S3 consumes
# this in `rollback()`. Each entry is a single line `<kind>:<payload>`:
#   symlink:<absolute-path>
#   claude-json-edited:NEW
#   claude-json-edited:<preedit-path>
#   zone-created:<absolute-path>
#   gitignore-line-added:<gitignore-path>:<line>
#   npm-installed
STATE_LOG=()

# Flag set by detect_preexisting_gan_dir; consumed by print_final_status.
PREEXISTING_GAN_DIR=""

# Set by feature_branch_warning when on the mid-pivot branch; consumed by
# print_final_status.
MIDPIVOT_WARNING_FIRED=0

# Per-run pre-edit copy of `~/.claude.json` (if any). The install branch
# of `main()` cleans this up after every other step succeeds; rollback
# uses it to restore the file on failure.
PREEDIT_CLAUDE_JSON=""

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
  STATE_LOG+=("npm-installed")
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
#
# Before the first byte of the JSON edit is written, this function makes
# a per-run pre-edit copy of `~/.claude.json` to
# `~/.claude.json.preedit-$$` and records its location (or the literal
# `NEW`, if the file did not exist) in STATE_LOG. The install branch of
# `main()` removes the per-run copy after every other install step
# succeeds; on failure, `rollback()` restores the file from it.
register_mcp_in_claude_json() {
  PREEDIT_CLAUDE_JSON="$HOME/.claude.json.preedit-$$"
  if [ -f "$CLAUDE_CONFIG_JSON" ]; then
    cp "$CLAUDE_CONFIG_JSON" "$PREEDIT_CLAUDE_JSON"
    STATE_LOG+=("claude-json-edited:$PREEDIT_CLAUDE_JSON")
  else
    STATE_LOG+=("claude-json-edited:NEW")
  fi

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

  local zone
  for zone in "$top/.gan-state" "$top/.gan-cache"; do
    if [ ! -d "$zone" ]; then
      mkdir -p "$zone"
      STATE_LOG+=("zone-created:$zone")
    fi
  done

  local gi="$top/.gitignore"
  # Ensure file exists so `grep -Fxq` has something to read; the grep
  # itself succeeds against a missing file with `|| true`, but creating
  # the file once keeps the append idempotent in either case.
  [ -f "$gi" ] || : >"$gi"
  local entry
  for entry in ".gan-state/" ".gan-cache/"; do
    if ! grep -Fxq "$entry" "$gi"; then
      printf '%s\n' "$entry" >>"$gi"
      STATE_LOG+=("gitignore-line-added:$gi:$entry")
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
# `~/.claude.json` registration, flags a pre-existing `.gan/` directory
# as a hand-delete target when detected, and surfaces the feature-branch
# mid-pivot warning when triggered.
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

  if [ "$MIDPIVOT_WARNING_FIRED" -eq 1 ]; then
    log_info ""
    log_info "Heads up: you are installing from the \`feature/stack-plugin-rfc\` branch."
    log_info "This branch is the mid-pivot RFC work for ClaudeAgents and is not functional end-to-end yet."
    log_info "Switch to the \`main\` branch once the pivot lands if you want a working install."
  fi

  log_info ""
  log_info "Restart Claude Code to pick up the new agents, skills, and config server."
}

# ---------------------------------------------------------------------------
# S3 — rollback, error trap, feature-branch warning, uninstall
# ---------------------------------------------------------------------------

# rollback
#
# Walks STATE_LOG in reverse and undoes each side-effect in turn. Best
# effort: each individual reversal is wrapped so a failure on one entry
# (e.g. a symlink the user already removed) does not prevent the rest
# of the log from being processed. Emits a brief stderr summary using
# framework prose; never re-uninstalls the framework's globally
# installed config server (per F4 — the user runs the named shell
# command in backticks instead).
rollback() {
  local mentioned_npm=0
  local i entry kind payload

  log_warn "ClaudeAgents installer: install failed; rolling back partial state."

  for (( i=${#STATE_LOG[@]}-1; i>=0; i-- )); do
    entry="${STATE_LOG[$i]}"
    kind="${entry%%:*}"
    payload="${entry#*:}"
    if [ "$kind" = "$entry" ]; then
      # No colon in entry (e.g. `npm-installed`); payload is empty.
      payload=""
    fi

    case "$kind" in
      symlink)
        # Remove the symlink only if it still exists as a symlink. We do
        # not chase the target; a target swap by a third party would be
        # undone by deleting the link, which is what we want.
        if [ -L "$payload" ]; then
          rm -f "$payload" 2>/dev/null || true
        fi
        ;;
      claude-json-edited)
        if [ "$payload" = "NEW" ]; then
          # We created the file; remove it.
          rm -f "$CLAUDE_CONFIG_JSON" 2>/dev/null || true
        else
          # Restore from the per-run preedit copy.
          if [ -f "$payload" ]; then
            mv "$payload" "$CLAUDE_CONFIG_JSON" 2>/dev/null || true
          fi
        fi
        ;;
      zone-created)
        # Only remove if empty — never blow away user data that landed
        # inside the zone after the installer created it.
        if [ -d "$payload" ]; then
          rmdir "$payload" 2>/dev/null || true
        fi
        ;;
      gitignore-line-added)
        # Payload is `<gitignore-path>:<line>`.
        local gi_file gi_line
        gi_file="${payload%%:*}"
        gi_line="${payload#*:}"
        if [ -f "$gi_file" ] && [ -n "$gi_line" ]; then
          # Remove the exact line. Use a temp file + atomic rename so a
          # crash mid-write cannot leave the .gitignore truncated.
          local gi_tmp="$gi_file.rollback-tmp.$$"
          grep -Fxv "$gi_line" "$gi_file" >"$gi_tmp" 2>/dev/null || true
          if [ -f "$gi_tmp" ]; then
            mv "$gi_tmp" "$gi_file" 2>/dev/null || true
          fi
        fi
        ;;
      npm-installed)
        # Intentional no-op: removing a globally installed Node package
        # mid-rollback is risky (other tools may depend on it). The user
        # runs the named shell command if they want to undo it.
        mentioned_npm=1
        ;;
      backup|pruned-symlink)
        # The once-per-machine backup is intentionally retained on
        # rollback — it is the user's safety net across runs, not a
        # per-run artifact. Pre-prune broken symlinks were already
        # broken; we do not resurrect them.
        :
        ;;
      *)
        # Unknown kind; ignore defensively.
        :
        ;;
    esac
  done

  # Clean up the per-run preedit copy if it survived (e.g. the JSON edit
  # succeeded but a later step failed and rollback restored it via mv).
  if [ -n "$PREEDIT_CLAUDE_JSON" ] && [ -f "$PREEDIT_CLAUDE_JSON" ]; then
    rm -f "$PREEDIT_CLAUDE_JSON" 2>/dev/null || true
  fi

  if [ "$mentioned_npm" -eq 1 ]; then
    log_warn "ClaudeAgents installer: the framework's config server remains globally installed; run \`npm uninstall -g @claudeagents/config-server\` to remove."
  fi

  log_warn "ClaudeAgents installer: rollback complete."
}

# on_error
#
# ERR-trap handler for the install branch of `main()`. Captures the
# original exit code, runs `rollback`, then re-exits with the captured
# code so the surrounding pipeline (and tests) see the original failure.
on_error() {
  local rc=$?
  # Disarm the trap so a failure inside `rollback` (best-effort itself)
  # does not recurse.
  trap - ERR
  rollback
  exit "$rc"
}

# feature_branch_warning
#
# Sets `MIDPIVOT_WARNING_FIRED=1` when the install is being run from a
# clone whose current branch is the literal string
# `feature/stack-plugin-rfc`. The trigger is hardcoded; there is no
# environment-variable override. The check is removed at the post-E1
# merge to `main` (per the R2-locked feature-branch warning lifecycle in
# `PROJECT_CONTEXT.md`).
feature_branch_warning() {
  MIDPIVOT_WARNING_FIRED=0
  local branch
  branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ "$branch" = "feature/stack-plugin-rfc" ]; then
    MIDPIVOT_WARNING_FIRED=1
  fi
}

# uninstall_main
#
# Implements `--uninstall`:
#   - Removes symlinks under `~/.claude/agents/` whose targets resolve
#     into `$REPO_ROOT/agents/`.
#   - Removes symlinks under `~/.claude/skills/` whose targets resolve
#     into `$REPO_ROOT/skills/`.
#   - Removes the `mcpServers.claudeagents-config` entry from
#     `~/.claude.json` via `node -e`, atomic temp+rename, sorted keys.
#     Leaves `mcpServers` as an empty object if no other entries remain.
#   - Leaves `.gan-state/`, `.gan-cache/`, `.claude/gan/`, the
#     once-per-machine backup, and the globally installed framework
#     package alone. Prints follow-up commands in backticks so the
#     user can clean those up by hand.
# Idempotent: a second invocation against an already-uninstalled HOME
# exits 0 with the same follow-up hints.
uninstall_main() {
  log_info "ClaudeAgents installer: uninstalling."

  local removed_links=0
  local agents_root="$REPO_ROOT/agents"
  local skills_root="$REPO_ROOT/skills"

  # Walk `~/.claude/agents/` and remove any symlink whose target lives
  # inside `$REPO_ROOT/agents/`. We compare by string prefix on the
  # symlink's target value — `readlink` returns the literal target the
  # link was created with, which (per `link_agents_and_skills`) is the
  # absolute path under `$REPO_ROOT`.
  local dir entry target
  for dir in "$CLAUDE_HOME/agents:$agents_root" "$CLAUDE_HOME/skills:$skills_root"; do
    local d="${dir%%:*}"
    local r="${dir#*:}"
    [ -d "$d" ] || continue
    shopt -s nullglob dotglob
    for entry in "$d"/*; do
      if [ -L "$entry" ]; then
        target="$(readlink "$entry" 2>/dev/null || true)"
        case "$target" in
          "$r"/*|"$r")
            rm -f "$entry"
            removed_links=$(( removed_links + 1 ))
            ;;
        esac
      fi
    done
    shopt -u nullglob dotglob
  done

  # Strip `mcpServers.claudeagents-config` from `~/.claude.json` if it
  # is present. Atomic temp+rename, sorted keys. If the file does not
  # exist, this is a no-op (nothing to clean).
  if [ -f "$CLAUDE_CONFIG_JSON" ]; then
    local tmp="$CLAUDE_CONFIG_JSON.tmp.$$"
    CLAUDE_CONFIG_JSON_PATH="$CLAUDE_CONFIG_JSON" \
    CLAUDE_CONFIG_TMP_PATH="$tmp" \
    node -e '
      const fs = require("fs");
      const src = process.env.CLAUDE_CONFIG_JSON_PATH;
      const dst = process.env.CLAUDE_CONFIG_TMP_PATH;
      let data = {};
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
      if (
        data &&
        typeof data.mcpServers === "object" &&
        data.mcpServers !== null &&
        !Array.isArray(data.mcpServers)
      ) {
        delete data.mcpServers["claudeagents-config"];
      }
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
  fi

  log_info ""
  log_info "ClaudeAgents installer: uninstall complete."
  log_info "  - Removed $removed_links framework symlink(s) from $CLAUDE_HOME/."
  log_info "  - Cleared the framework entry from $CLAUDE_CONFIG_JSON (when present)."
  log_info ""
  log_info "Left in place (clean up by hand if you want them gone):"
  log_info "  - The framework's globally installed package: \`npm uninstall -g @claudeagents/config-server\`."
  log_info "  - Per-project zones: \`rm -rf .gan-state .gan-cache\` (run from each repo)."
  log_info "  - Project overlays under \`.claude/gan/\` and the once-per-machine \`~/.claude.json\` backup are untouched."
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
    uninstall_main
    exit 0
  fi

  # Inherit the ERR trap into shell functions and subshells. Combined
  # with `set -e`, this means any unhandled non-zero exit anywhere in
  # the install branch routes through `on_error` -> `rollback`.
  set -E
  trap on_error ERR

  feature_branch_warning

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

  # Every state-creating step has succeeded — disarm the rollback trap
  # and remove the per-run preedit copy of `~/.claude.json` (if any).
  trap - ERR
  if [ -n "$PREEDIT_CLAUDE_JSON" ] && [ -f "$PREEDIT_CLAUDE_JSON" ]; then
    rm -f "$PREEDIT_CLAUDE_JSON"
  fi

  print_final_status
  exit 0
}

main "$@"
