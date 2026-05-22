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
CLAUDE_SETTINGS_JSON="$HOME/.claude/settings.json"
# (H1) Framework-owned PreToolUse confinement hook. Content is rendered from
# the single source-of-truth template under the repo; the on-disk path is fixed
# and the content is regenerated on every install (no version tracking).
CONFINE_HOOK_PATH="$HOME/.claude/hooks/gan-confine.sh"
CONFINE_HOOK_TEMPLATE="$REPO_ROOT/scripts/hooks/gan-confine.sh.template"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=10
# Highest Node major the framework's CI has been exercised through. Above
# this ceiling, `check_node` warns and continues; it does not refuse to
# install. Bump this constant when CI gains coverage on a new major.
TESTED_THROUGH_NODE_MAJOR=25
# Where users are pointed when the installer asks for a bug report (today:
# only the tested-through Node-version warning). Surfaced as a constant so
# downstream prose surfaces (uninstall failure paths, future rollback
# messages) can consume the same URL without each path hardcoding it.
BUG_REPORT_URL="https://github.com/Thomas-AppForceOne/ClaudeAgents/issues"

# STATE_LOG — append-only audit trail of state-creating steps. S3 consumes
# this in `rollback()`. Each entry is a single line `<kind>:<payload>`:
#   copied-file:<absolute-path>
#   copied-dir:<absolute-path>
#   builtin-stacks-symlink:<absolute-path>
#   claude-json-edited:NEW
#   claude-json-edited:<preedit-path>
#   claude-settings-edited:NEW
#   claude-settings-edited:<preedit-path>
#   zone-created:<absolute-path>
#   gitignore-line-added:<gitignore-path>:<line>
#   npm-installed
#   confine-hook-written:<absolute-path>
# (H1) `confine-hook-written` records the rendered ~/.claude/hooks/gan-confine.sh
# the install wrote; rollback removes the partial hook file at that path. Its
# settings.json `hooks.PreToolUse[]` registration rides the existing
# `claude-settings-edited` entry — write_confine_hook takes the settings preedit
# snapshot BEFORE merging the registration, so settings restoration is already
# covered by the claude-settings-edited rollback case.
# The `symlink:<absolute-path>` kind is retained as a legacy entry — it is
# still recognised by `rollback()` but is no longer emitted by current
# install paths (which copy files, not symlink them).
STATE_LOG=()

# Flag set by detect_preexisting_gan_dir; consumed by print_final_status.
PREEXISTING_GAN_DIR=""

# Set by feature_branch_warning when on the mid-pivot branch; consumed by
# print_final_status.
MIDPIVOT_WARNING_FIRED=0

# Set by create_builtin_stacks_symlink when the symlink at
# `~/.claude/gan/builtin-stacks/` is in place after the install body
# runs; consumed by print_final_status.
BUILTIN_STACKS_LINKED=0

# (H1) Absolute path to a project-tier confinement hook detected in the
# current repo (`<repo-top>/.claude/hooks/gan-confine.sh`), set by
# detect_project_tier_confine_hook; consumed by print_final_status to emit the
# non-blocking override warning. Empty when no project-tier hook is present (or
# the install is run outside a git repo). DISTINCT from CONFINE_HOOK_PATH (the
# user-tier hook under $HOME) — the two are never confused, even when $HOME is
# the repo top (the sandboxed-$HOME test case).
PROJECT_TIER_HOOK_DETECTED=""

# Per-run pre-edit copy of `~/.claude.json` (if any). The install branch
# of `main()` cleans this up after every other step succeeds; rollback
# uses it to restore the file on failure.
PREEDIT_CLAUDE_JSON=""

# Per-run pre-edit copy of `~/.claude/settings.json` (if any). Symmetric
# with PREEDIT_CLAUDE_JSON above. Cleaned up by main() on success;
# consumed by rollback() on failure.
PREEDIT_CLAUDE_SETTINGS=""

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

This is a once-per-machine installation. It modifies your user-level
Claude Code configuration (under `~/.claude/`) so every project on your
machine can invoke `/gan` and the `gan` CLI. Per-project filesystem zones
(`.gan-state/`, `.gan-cache/`) are created lazily on first `/gan` use
inside each repository — there is no per-project install step.

Usage:
  install.sh [flags]

Flags:
  --help, -h          Show this help and exit.
  --uninstall         Reverse a previous install (remove framework files
                      and the Claude Code config entry; user data is left
                      intact).
  --no-claude-code    Skip the Claude Code prerequisite check. Use on CI
                      runners or headless environments that consume the
                      framework directly without Claude Code hosting it.
  --approve-all-permissions
                      Approve every permission category without prompting.
                      Useful for CI runners that test the framework
                      end-to-end. Mutually exclusive with
                      `--minimal-permissions`.
  --minimal-permissions
                      Approve only the framework MCP category (the
                      minimum). Other categories stay unset; Claude Code
                      will prompt for each call mid-sprint. Mutually
                      exclusive with `--approve-all-permissions`.
  --reconfigure-permissions
                      Re-run the permission prompt sequence even when
                      categories are already granted. Useful for
                      revoking a previously approved category by
                      declining now.

What it does:
  - Copies ClaudeAgents agents and skills into your Claude Code config
    directory (typically `~/.claude/`). Once install completes, the source
    repo can be moved or deleted without breaking the install.
  - Installs the framework's config server globally so Claude Code can
    register it.
  - Registers the config-server entry in your Claude Code config
    (`~/.claude.json`).
  - Prepares per-project filesystem zones (`.gan-state/` and `.gan-cache/`)
    when run inside a git repository.

Prerequisites:
  - `node` `20.10` or newer on PATH. The framework is tested through `node`
    `25`; newer majors will install but are not yet exercised. Install
    via your package manager (for example `brew install` on macOS, or
    `nvm` on Linux). See https://nodejs.org/ for full instructions.
  - `git` on PATH.
  - Claude Code installed and on PATH (skip with --no-claude-code).

Exit codes:
  0  Success.
  Non-zero on any failure; the message names what failed and how to fix it.

After install:
  - Restart Claude Code to pick up the new agents, skills, and config server.
  - After restart, type `/gan --help` in any project to get started.
  - Optional: copy `templates/claude-settings.json` to your project's
    `.claude/settings.json` (or merge it into an existing one) to suppress
    Claude Code permission prompts during `/gan` runs. The template
    allowlists only the operations the `/gan` agent loop performs in a
    typical sprint — destructive commands still prompt.

For more, see the project README.
HELP
}

check_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node is not on PATH. ClaudeAgents requires Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer. See https://nodejs.org/."
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

  # Lower-bound rejection text — shared between the major-too-old and the
  # major-OK-minor-too-old branches so the user sees identical, actionable
  # remediation regardless of which condition tripped. Matches the spec
  # example in `specifications/I3-uninstall-and-version-policy.md` § "Node
  # version policy" (modulo the `v` prefix that `$stripped` drops).
  local lower_bound_error
  lower_bound_error="Node $stripped is below the framework's required minimum (Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}). Install Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer via your package manager (for example \`brew install node\` on macOS, or \`nvm install ${MIN_NODE_MAJOR}\` on Linux). See https://nodejs.org/ for details."

  if [ "$major" -lt "$MIN_NODE_MAJOR" ]; then
    die "$lower_bound_error"
  fi
  if [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -lt "$MIN_NODE_MINOR" ]; then
    die "$lower_bound_error"
  fi
  if [ "$major" -gt "$TESTED_THROUGH_NODE_MAJOR" ]; then
    # Warn-not-die per `specifications/I3-uninstall-and-version-policy.md`.
    # The constant is a tested-through ceiling, not a known-incompatibility
    # cap; locking out users on a newer major produced no functional benefit
    # and silenced exactly the dogfooding population most likely to file
    # useful bug reports. Bump `TESTED_THROUGH_NODE_MAJOR` once CI gains
    # coverage on the new major.
    log_warn "Node $stripped is newer than this framework version has been tested through (Node ${TESTED_THROUGH_NODE_MAJOR}.x). The install will continue. If you encounter issues, please report them at ${BUG_REPORT_URL} so the tested-through ceiling can be raised."
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

# install_agents_and_skills
#
# Copies `$REPO_ROOT/agents/*.md` into `$CLAUDE_HOME/agents/` and
# `$REPO_ROOT/skills/gan/` into `$CLAUDE_HOME/skills/gan/` as real
# files / directories. Idempotent: re-runs replace existing copies in
# place. Migrates legacy symlink-based installs in the same step —
# symlinks at the target paths are removed before the copy lands, so a
# user who installed before the symlink-to-copy migration runs
# `install.sh` once and ends up on the new shape.
#
# After install completes, the user can move or delete the source
# repo without breaking the install — the copies under `$CLAUDE_HOME`
# are independent of `$REPO_ROOT`.
install_agents_and_skills() {
  mkdir -p "$CLAUDE_HOME/agents"
  mkdir -p "$CLAUDE_HOME/skills"

  local f name target
  shopt -s nullglob
  for f in "$REPO_ROOT/agents/"*.md; do
    name="$(basename "$f")"
    target="$CLAUDE_HOME/agents/$name"
    # Remove any prior version (legacy symlink or stale copy) before
    # writing the new file. `cp` would clobber a regular file but cannot
    # replace a symlink in a single step on all platforms.
    if [ -L "$target" ] || [ -f "$target" ]; then
      rm -f "$target"
    fi
    cp "$f" "$target"
    STATE_LOG+=("copied-file:$target")
  done
  shopt -u nullglob

  if [ -d "$REPO_ROOT/skills/gan" ]; then
    target="$CLAUDE_HOME/skills/gan"
    # Remove any prior version: legacy symlink, or a directory from a
    # previous copy install (which may contain stale files removed in
    # this version). `rm -rf` is safe here — the target path is owned
    # by the framework per the install contract.
    if [ -L "$target" ]; then
      rm -f "$target"
    elif [ -d "$target" ]; then
      rm -rf "$target"
    fi
    cp -R "$REPO_ROOT/skills/gan" "$target"
    STATE_LOG+=("copied-dir:$target")
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
  out="$(claudeagents-config-server --version </dev/null 2>/dev/null || true)"
  # Strip trailing newline / whitespace and a leading `v` if present.
  out="${out%%$'\n'*}"
  out="${out## }"
  out="${out%% }"
  printf '%s' "${out#v}"
}

# verify_mcp_bin_on_path
#
# Confirms `claudeagents-config-server` is reachable on PATH after the
# npm install step. `npm install -g .` can succeed logically while
# failing to create the bin shim — for example, when `dist/` is absent
# because `npm run build` never ran. Without this check, install
# reports success but Claude Code's MCP launcher cannot find the
# server, and the `/gan` skill silently fails to register.
#
# Wrapped in a helper (rather than inlined into main()) because
# `return 1` from a helper triggers the ERR trap installed in main(),
# routing through `on_error -> rollback` cleanly. `return 1` from
# main() directly does NOT trigger ERR — the trap was set inside main
# and expires once main returns, leaving no handler for the calling
# site's non-zero exit.
verify_mcp_bin_on_path() {
  if ! command -v claudeagents-config-server >/dev/null 2>&1; then
    log_error "ClaudeAgents installer: \`claudeagents-config-server\` is not on PATH after install."
    log_error "The framework's npm package linked but its executable did not. This typically means the build artifact at \`dist/\` was not produced — verify \`npm run build\` runs cleanly inside $REPO_ROOT, then re-run \`./install.sh\`."
    return 1
  fi
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
    log_error "Re-run \`npm install -g .\` from $REPO_ROOT to see the underlying error."
    # `return 1` (rather than `die ...`) so the ERR trap installed in
    # `main()` fires in the parent shell context. Bash 4.4+ does not
    # propagate `set -e` into command substitution by default
    # (`inherit_errexit` opt), which means the trap does NOT fire from
    # inside the `$(cd ... && npm install)` subshell when npm exits
    # non-zero. Returning from the function instead lets the trap fire
    # at the call site, where rollback() runs in the parent and
    # actually undoes the symlinks. (On bash 3.2 — the macOS system
    # bash — this behavior was the default; on bash 5 it requires
    # either `inherit_errexit` or this re-routing through the function
    # return. We do both: see the `shopt -s inherit_errexit` near the
    # top of `main()` for the bash-4.4+ side of the fix.)
    return 1
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

# I2 sprint 3a — Permission consent flow.
#
# Permission category catalog. Authored as a JSON document so both bash
# (loop / prompt) and node (JSON merge into ~/.claude/settings.json)
# read from the same source of truth. Single-quoted bash string so `$`
# tokens (none here, but defensive) are not interpolated.
#
# Each category has:
#   - name: human-readable label shown in the prompt
#   - summary: one-line gloss, also shown in the prompt
#   - required: when true, declining aborts the install (today: only
#     category 1, the framework MCP server, since /gan cannot function
#     without it)
#   - tools: the literal entries written into `permissions.allow` if
#     the category is approved. The strings match Claude Code's
#     permission-pattern syntax verbatim.
#
# The catalog matches `specifications/I2-install-user-facing-surfaces.md`
# § "The eight categories" verbatim for `name` + `tools`. Sprint 3b's
# idempotency relies on exact-string matches between this catalog and
# whatever is already in `permissions.allow`.
CATEGORIES_JSON='[
  {
    "name": "Framework MCP server",
    "summary": "mcp__claudeagents-config__*",
    "required": true,
    "tools": ["mcp__claudeagents-config__*"]
  },
  {
    "name": "File operations",
    "summary": "Read, Write, Edit, Glob, Grep",
    "required": false,
    "tools": ["Read", "Write", "Edit", "Glob", "Grep"]
  },
  {
    "name": "Sub-agents",
    "summary": "Agent, TodoWrite",
    "required": false,
    "tools": ["Agent", "TodoWrite"]
  },
  {
    "name": "Git read",
    "summary": "git status, diff, log, show, branch, rev-parse, worktree list",
    "required": false,
    "tools": [
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(git branch:*)",
      "Bash(git rev-parse:*)",
      "Bash(git worktree list:*)"
    ]
  },
  {
    "name": "Git write",
    "summary": "git add, commit, checkout, worktree add/remove/prune",
    "required": false,
    "tools": [
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git checkout:*)",
      "Bash(git worktree add:*)",
      "Bash(git worktree remove:*)",
      "Bash(git worktree prune:*)"
    ]
  },
  {
    "name": "Build & test",
    "summary": "npm test, npm run, npm audit",
    "required": false,
    "tools": [
      "Bash(npm test:*)",
      "Bash(npm run:*)",
      "Bash(npm audit:*)"
    ]
  },
  {
    "name": "Dependency install",
    "summary": "npm install",
    "required": false,
    "tools": ["Bash(npm install:*)"]
  },
  {
    "name": "Filesystem helpers",
    "summary": "ls, cat, mkdir, realpath, test, echo",
    "required": false,
    "tools": [
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(mkdir:*)",
      "Bash(realpath:*)",
      "Bash(test:*)",
      "Bash(echo:*)"
    ]
  }
]'

# configure_permissions
#
# Walks the 8 permission categories above and merges approved tool
# patterns into `~/.claude/settings.json` `permissions.allow`. The merge
# is atomic (temp + sorted-key + trailing newline + mv) and additive
# (existing user-authored entries are preserved).
#
# Behaviour by mode:
#   - **Non-TTY** (CI, scripted invocations, every test in
#     `tests/installer/`). Skips the prompt sequence entirely. Adds
#     ONLY category 1 (the framework MCP server) — without that the
#     server cannot register. Other categories stay unset; the user can
#     re-run `install.sh` interactively to add them. This default-
#     minimal behaviour is the contract that lets the existing test
#     harness keep passing without each test having to thread a flag.
#   - **TTY**. Prompts for each category in turn (default `[Y]`).
#     `[a]` = approve all remaining; `[s]` = skip all remaining;
#     `[v]` = view the literal tool patterns, then re-prompt the same
#     category. Decline of category 1 (the only required one) aborts
#     the install with a structured error.
#
# Sprint 3b will add `--approve-all-permissions`, `--minimal-
# permissions`, `--reconfigure-permissions` flags; idempotent re-runs
# (skip already-granted categories); and the uninstall integration that
# removes only the framework's added entries.
# ensure_settings_preedit_snapshot
#
# (H1) Idempotently snapshots `~/.claude/settings.json` for rollback before
# the FIRST settings.json mutation of this run, recording a single
# `claude-settings-edited` STATE_LOG entry. Both `write_confine_hook` (the
# PreToolUse registration merge) and `configure_permissions` (the
# permissions.allow merge) edit settings.json; whichever runs first takes the
# snapshot, and the second call is a no-op. This guarantees the preedit copy
# captures the pre-run state (not an already-merged intermediate), so the
# existing `claude-settings-edited` rollback case byte-restores (or removes)
# the file regardless of which merges ran.
#
# Sets the global PREEDIT_CLAUDE_SETTINGS to the preedit copy path on the
# pre-existing-file path, or leaves it empty and records `:NEW` when the file
# did not exist (rollback then removes the file outright). Re-entrancy is
# detected by scanning STATE_LOG for an existing `claude-settings-edited`
# entry — once one is present the snapshot has already been taken.
ensure_settings_preedit_snapshot() {
  local e
  for e in "${STATE_LOG[@]:-}"; do
    case "$e" in
      claude-settings-edited:*) return 0 ;;
    esac
  done
  if [ -f "$CLAUDE_SETTINGS_JSON" ]; then
    PREEDIT_CLAUDE_SETTINGS="$HOME/.claude/settings.json.preedit-$$"
    cp "$CLAUDE_SETTINGS_JSON" "$PREEDIT_CLAUDE_SETTINGS"
    STATE_LOG+=("claude-settings-edited:$PREEDIT_CLAUDE_SETTINGS")
  else
    STATE_LOG+=("claude-settings-edited:NEW")
    # Ensure parent directory exists for the atomic-write rename target.
    mkdir -p "$(dirname "$CLAUDE_SETTINGS_JSON")"
  fi
}

# write_confine_hook
#
# (H1) Renders the framework-owned PreToolUse confinement hook from its single
# source-of-truth template (`scripts/hooks/gan-confine.sh.template`) and writes
# it to `~/.claude/hooks/gan-confine.sh`, then registers its ABSOLUTE path in
# `~/.claude/settings.json` under `hooks.PreToolUse[]`.
#
# The hook body is never re-authored here — install.sh reads the template and
# substitutes only the `__GAN_FRAMEWORK_VERSION__` placeholder with the
# framework version read at runtime from package.json (read_mcp_server_version,
# the R2-locked `node -p` version source — never a hardcoded constant).
#
# Regeneration: the hook is overwritten on every install (no version-tracking
# short-circuit), so an F1 zone rework lands on disk the next time install.sh
# runs. The settings.json merge is additive (unrelated PreToolUse entries and
# other settings survive) and idempotent (deduped on the absolute hook path —
# a re-run does not append a second entry for the same path).
#
# Security posture (sprint-2 contract: shell_and_subprocess_safety): no `eval`;
# every path/version expansion is double-quoted; the version flows into the
# rendered template as DATA via node reading it from the environment (it is
# never interpolated into a shell command line, and the rendered hook is only
# written + chmod'd — install.sh never sources or executes it); the JSON merge
# reads the hook path from an environment variable (like the existing
# CLAUDE_SETTINGS_PATH / CLAUDE_MCP_BIN_ABS pattern), never by concatenating it
# into the node program text. Atomic *.tmp.$$ + mv writes throughout; bash-3.2
# floor respected.
write_confine_hook() {
  local hooks_dir version tmp_hook
  hooks_dir="$(dirname "$CONFINE_HOOK_PATH")"
  mkdir -p "$hooks_dir"

  # Version is read at runtime and treated purely as data downstream.
  version="$(read_mcp_server_version)"

  # Render: substitute the literal placeholder with the version. node reads
  # both the template (from the path in an env var) and the version (from an
  # env var) as data and replaces every occurrence of the exact placeholder
  # token — the version bytes are never parsed as code or as a regex.
  tmp_hook="$CONFINE_HOOK_PATH.tmp.$$"
  CONFINE_TEMPLATE_PATH="$CONFINE_HOOK_TEMPLATE" \
  CONFINE_HOOK_TMP="$tmp_hook" \
  CONFINE_FRAMEWORK_VERSION="$version" \
  node -e '
    const fs = require("fs");
    const tpl = fs.readFileSync(process.env.CONFINE_TEMPLATE_PATH, "utf8");
    const version = process.env.CONFINE_FRAMEWORK_VERSION;
    // Literal split/join replacement — no regex, so version bytes cannot be
    // interpreted as regex metacharacters or replacement-string specials.
    const rendered = tpl.split("__GAN_FRAMEWORK_VERSION__").join(version);
    fs.writeFileSync(process.env.CONFINE_HOOK_TMP, rendered, "utf8");
  '
  chmod +x "$tmp_hook"
  mv "$tmp_hook" "$CONFINE_HOOK_PATH"

  # Record the written hook for rollback BEFORE touching settings.json, so a
  # failure during the registration merge still rolls back the partial hook.
  STATE_LOG+=("confine-hook-written:$CONFINE_HOOK_PATH")

  # Take the settings preedit snapshot BEFORE merging the registration, so the
  # registration restoration rides the existing claude-settings-edited case.
  ensure_settings_preedit_snapshot

  # Resolve the hook path to a real absolute path for the registration entry
  # (the constant is already absolute and `~`-free since it is built from
  # $HOME, but resolve the parent dir defensively so the entry never carries a
  # literal `~` or a relative segment).
  local hook_abs
  hook_abs="$(cd "$hooks_dir" && pwd)/$(basename "$CONFINE_HOOK_PATH")"

  # Atomic, additive, idempotent merge of the PreToolUse registration via node.
  # Mirrors the permissions.allow merge in configure_permissions: reads values
  # from the environment as data, dedupes on the absolute hook path, and emits
  # sorted-key + 2-space-indent + trailing-newline JSON to a *.tmp.$$ sibling,
  # then mv's into place.
  local tmp="$CLAUDE_SETTINGS_JSON.tmp.$$"
  CLAUDE_SETTINGS_PATH="$CLAUDE_SETTINGS_JSON" \
  CLAUDE_SETTINGS_TMP="$tmp" \
  CONFINE_HOOK_ABS="$hook_abs" \
  node -e '
    const fs = require("fs");
    const src = process.env.CLAUDE_SETTINGS_PATH;
    const dst = process.env.CLAUDE_SETTINGS_TMP;
    const hookAbs = process.env.CONFINE_HOOK_ABS;
    if (!hookAbs) {
      console.error("install.sh: confinement hook path not set.");
      process.exit(1);
    }
    let data = {};
    if (fs.existsSync(src)) {
      const raw = fs.readFileSync(src, "utf8");
      if (raw.trim().length > 0) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error("install.sh: ~/.claude/settings.json is not valid JSON: " + e.message);
          process.exit(1);
        }
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          console.error("install.sh: ~/.claude/settings.json must be a JSON object.");
          process.exit(1);
        }
      }
    }
    if (typeof data.hooks !== "object" || data.hooks === null || Array.isArray(data.hooks)) {
      data.hooks = {};
    }
    if (!Array.isArray(data.hooks.PreToolUse)) {
      data.hooks.PreToolUse = [];
    }
    // Has the framework hook (by absolute command path) already been
    // registered? Scan every entry and its nested hooks[] for the path so a
    // re-run is idempotent regardless of the entry shape Claude Code wrote.
    const mentionsHook = (entry) => {
      if (!entry || typeof entry !== "object") return false;
      if (entry.command === hookAbs) return true;
      if (Array.isArray(entry.hooks)) {
        return entry.hooks.some((h) => h && typeof h === "object" && h.command === hookAbs);
      }
      return false;
    };
    if (!data.hooks.PreToolUse.some(mentionsHook)) {
      data.hooks.PreToolUse.push({
        matcher: "Write|Edit|MultiEdit|NotebookEdit",
        hooks: [{ type: "command", command: hookAbs }],
      });
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
  mv "$tmp" "$CLAUDE_SETTINGS_JSON"

  # (AC-A4 enablement) Optional failure injection point: a post-write step
  # that fails so tests can exercise rollback of the partial hook + the
  # registration. Env-flagged stub surface only — never patches install.sh.
  if [ "${CAS_FAIL_CONFINE_HOOK_WRITE:-0}" = "1" ]; then
    log_error "install.sh: injected confine-hook-write failure"
    return 1
  fi
}

configure_permissions() {
  # Decide which categories to approve.
  local approved_indices_csv=""

  # Compute the list of categories whose tools are ALL already in the
  # existing `permissions.allow`. Idempotent re-runs skip these (one
  # log line per skipped category) unless `--reconfigure-permissions`
  # was passed. The result is a CSV of 0-based indices that should be
  # treated as "already granted" — they are not re-prompted, not re-
  # added (no-op duplicates the merge would deduplicate anyway), and
  # NOT removed from approved_indices_csv at the end (the existing
  # entries are simply preserved by the additive merge).
  local already_granted_csv=""
  if [ -f "$CLAUDE_SETTINGS_JSON" ] && [ "${RECONFIGURE_PERMISSIONS:-0}" -ne 1 ]; then
    already_granted_csv="$(
      CLAUDE_SETTINGS_PATH="$CLAUDE_SETTINGS_JSON" \
      CLAUDE_CATEGORIES_JSON="$CATEGORIES_JSON" \
      node -e '
        const fs = require("fs");
        let data = {};
        try { data = JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH, "utf8") || "{}"); }
        catch (_e) { data = {}; }
        const have = new Set(
          (data && data.permissions && Array.isArray(data.permissions.allow))
            ? data.permissions.allow.map(String)
            : []
        );
        const cats = JSON.parse(process.env.CLAUDE_CATEGORIES_JSON);
        const out = [];
        cats.forEach((cat, i) => {
          if (Array.isArray(cat.tools) && cat.tools.length > 0 && cat.tools.every((t) => have.has(t))) {
            out.push(i);
          }
        });
        process.stdout.write(out.join(","));
      '
    )"
  fi

  # `is_already_granted` shell helper: returns 0 (true) if `$1` (a
  # numeric category index) appears in already_granted_csv.
  is_already_granted() {
    local idx="$1"
    case ",$already_granted_csv," in
      *",$idx,"*) return 0 ;;
      *) return 1 ;;
    esac
  }

  # Flag-driven non-interactive modes (these win over TTY detection):
  if [ "${PERMISSION_MODE:-}" = "approve-all" ]; then
    # Build CSV of all category indices via node.
    approved_indices_csv="$(
      printf '%s' "$CATEGORIES_JSON" | node -e '
        const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
        process.stdout.write(d.map((_c, i) => String(i)).join(","));
      '
    )"
  elif [ "${PERMISSION_MODE:-}" = "minimal" ]; then
    approved_indices_csv="0"
  elif [ ! -t 0 ]; then
    # Non-TTY default: minimal (category 0 only — index is 0-based here
    # so the JSON merge step below can pass it straight to node).
    approved_indices_csv="0"
  else
    # TTY interactive prompt sequence.
    log_info ""
    log_info "ClaudeAgents installer: configuring Claude Code permissions for /gan runs."
    log_info ""
    log_info "Each category corresponds to operations the framework needs during a sprint."
    log_info "Approving up-front means the operation runs without prompting mid-sprint."
    log_info "Declining means Claude Code prompts for each call (loud, but full per-call review)."
    log_info ""
    log_info "Press [a] to approve all remaining, [s] to skip all remaining, or [v] to view"
    log_info "the exact tools/commands a category covers before deciding."
    log_info ""

    # Resolve category metadata once via node.
    local cat_count
    cat_count="$(printf '%s' "$CATEGORIES_JSON" | node -e '
      const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
      console.log(data.length);
    ')"

    local approve_all=0 skip_all=0 i name summary required answer
    local approved=()
    for ((i = 0; i < cat_count; i++)); do
      name="$(printf '%s' "$CATEGORIES_JSON" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        process.stdout.write(d[$i].name);
      ")"
      summary="$(printf '%s' "$CATEGORIES_JSON" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        process.stdout.write(d[$i].summary);
      ")"
      required="$(printf '%s' "$CATEGORIES_JSON" | node -e "
        const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
        process.stdout.write(d[$i].required ? 'true' : 'false');
      ")"

      # Idempotency: a category whose tools are ALL already in
      # ~/.claude/settings.json is silently skipped (one log line).
      # `--reconfigure-permissions` (which clears already_granted_csv
      # at the top of the function) overrides this.
      if is_already_granted "$i"; then
        log_info "[$((i+1))/$cat_count] $name  ($summary) — already granted; skipping."
        continue
      fi
      if [ "$skip_all" -eq 1 ] && [ "$required" != "true" ]; then
        log_info "[$((i+1))/$cat_count] $name  ($summary) — skipped"
        continue
      fi
      if [ "$approve_all" -eq 1 ]; then
        log_info "[$((i+1))/$cat_count] $name  ($summary) — approved"
        approved+=("$i")
        continue
      fi

      log_info "[$((i+1))/$cat_count] $name  ($summary)"
      if [ "$required" = "true" ]; then
        log_info "      Required for /gan to function at all. Declining here aborts install."
      fi

      while true; do
        if [ "$required" = "true" ]; then
          printf '      Approve? [Y/n] '
        else
          printf '      Approve? [Y/n/v] '
        fi
        IFS= read -r answer || answer=""
        case "$answer" in
          ''|y|Y) approved+=("$i"); break ;;
          n|N)
            if [ "$required" = "true" ]; then
              die "Permission category '$name' is required; cannot install. Re-run \`install.sh\` and approve category 1 to continue."
            fi
            break
            ;;
          a|A) approve_all=1; approved+=("$i"); break ;;
          s|S)
            skip_all=1
            if [ "$required" = "true" ]; then
              # Required category cannot be skipped via [s] either.
              die "Permission category '$name' is required; cannot install. Re-run \`install.sh\` and approve category 1 to continue."
            fi
            break
            ;;
          v|V)
            if [ "$required" = "true" ]; then
              log_warn "      [v] is not available for required categories."
              continue
            fi
            log_info "      Tools/commands this category covers:"
            printf '%s' "$CATEGORIES_JSON" | node -e "
              const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
              for (const t of d[$i].tools) console.log('        ' + t);
            "
            ;;
          *) log_warn "      Unrecognised input. Please type Y, n, a, s, or v." ;;
        esac
      done
    done

    # Build CSV from `approved` array (bash 3.x-friendly: avoid IFS join).
    local idx
    for idx in "${approved[@]:-}"; do
      [ -z "$idx" ] && continue
      if [ -z "$approved_indices_csv" ]; then
        approved_indices_csv="$idx"
      else
        approved_indices_csv="$approved_indices_csv,$idx"
      fi
    done
  fi

  # Skip the merge entirely if nothing was approved (e.g. user typed `n`
  # at every non-required category and category 1 was somehow not
  # required — defensive; should not happen with the current catalog).
  if [ -z "$approved_indices_csv" ]; then
    return 0
  fi

  # Snapshot the existing settings.json (if any) for rollback. Idempotent: if
  # write_confine_hook (which runs earlier in main()) already snapshotted this
  # run's settings.json, this is a no-op so the preedit copy keeps the
  # pre-run state rather than the post-registration-merge intermediate.
  ensure_settings_preedit_snapshot

  # Atomic merge via node. Preserves existing `permissions.allow`
  # entries; appends the approved categories' tool patterns; sorts
  # `permissions.allow` alphabetically; emits sorted-key + 2-space-indent
  # + trailing-newline JSON to a temp sibling, then `mv`s into place.
  local tmp="$CLAUDE_SETTINGS_JSON.tmp.$$"
  CLAUDE_SETTINGS_PATH="$CLAUDE_SETTINGS_JSON" \
  CLAUDE_SETTINGS_TMP="$tmp" \
  CLAUDE_CATEGORIES_JSON="$CATEGORIES_JSON" \
  CLAUDE_APPROVED_CSV="$approved_indices_csv" \
  node -e '
    const fs = require("fs");
    const src = process.env.CLAUDE_SETTINGS_PATH;
    const dst = process.env.CLAUDE_SETTINGS_TMP;
    const cats = JSON.parse(process.env.CLAUDE_CATEGORIES_JSON);
    const approved = process.env.CLAUDE_APPROVED_CSV.split(",")
      .filter((s) => s.length > 0)
      .map((s) => Number(s));
    let data = {};
    if (fs.existsSync(src)) {
      const raw = fs.readFileSync(src, "utf8");
      if (raw.trim().length > 0) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error("install.sh: ~/.claude/settings.json is not valid JSON: " + e.message);
          process.exit(1);
        }
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          console.error("install.sh: ~/.claude/settings.json must be a JSON object.");
          process.exit(1);
        }
      }
    }
    if (typeof data.permissions !== "object" || data.permissions === null || Array.isArray(data.permissions)) {
      data.permissions = {};
    }
    if (!Array.isArray(data.permissions.allow)) {
      data.permissions.allow = [];
    }
    const existing = new Set(data.permissions.allow.map(String));
    for (const i of approved) {
      const cat = cats[i];
      if (!cat || !Array.isArray(cat.tools)) continue;
      for (const t of cat.tools) {
        if (!existing.has(t)) {
          existing.add(t);
        }
      }
    }
    data.permissions.allow = Array.from(existing).sort();
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
  mv "$tmp" "$CLAUDE_SETTINGS_JSON"
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

  # Resolve the absolute path to `claudeagents-config-server` and write
  # it into the MCP registration. On macOS, Claude Code is launched as a
  # GUI app from Finder / Dock / Spotlight and inherits a minimal `PATH`
  # like `/usr/bin:/bin:/usr/sbin:/sbin` — it does NOT pick up Homebrew's
  # `/opt/homebrew/bin/`, npm's prefix, or whatever shell mods the user
  # has set in `.zshrc`. Registering with a bare command name (`command:
  # "claudeagents-config-server"`) makes Claude Code fail to spawn the
  # MCP server because it can't resolve the binary against its restricted
  # PATH. Using the absolute path bypasses the issue entirely.
  local mcp_bin_abs
  if ! mcp_bin_abs="$(command -v claudeagents-config-server 2>/dev/null)" \
       || [ -z "$mcp_bin_abs" ]; then
    log_error "ClaudeAgents installer: cannot resolve absolute path for \`claudeagents-config-server\`. The bin verification earlier should have caught this."
    return 1
  fi

  local tmp="$CLAUDE_CONFIG_JSON.tmp.$$"
  CLAUDE_CONFIG_JSON_PATH="$CLAUDE_CONFIG_JSON" \
  CLAUDE_CONFIG_TMP_PATH="$tmp" \
  CLAUDE_MCP_BIN_ABS="$mcp_bin_abs" \
  node -e '
    const fs = require("fs");
    const src = process.env.CLAUDE_CONFIG_JSON_PATH;
    const dst = process.env.CLAUDE_CONFIG_TMP_PATH;
    const binAbs = process.env.CLAUDE_MCP_BIN_ABS;
    if (!binAbs) {
      console.error("install.sh: CLAUDE_MCP_BIN_ABS not set.");
      process.exit(1);
    }
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
      command: binAbs,
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
    # An empty `.gan/` is no data risk and the "Delete it by hand once
    # you have copied anything you still need" hint would be misleading —
    # there is nothing to copy. Silently skip the warning in that case.
    # `find -mindepth 1 -print -quit` prints the first entry (file or
    # subdir, hidden included) and exits, returning empty for an empty
    # directory.
    if [ -n "$(find "$top/.gan" -mindepth 1 -print -quit 2>/dev/null)" ]; then
      PREEXISTING_GAN_DIR="$top/.gan"
    fi
  fi
}

# detect_project_tier_confine_hook
#
# (H1, AC-A7) When the cwd is a git repo whose top contains a project-tier
# confinement hook at `<repo-top>/.claude/hooks/gan-confine.sh`, record its
# absolute path in PROJECT_TIER_HOOK_DETECTED so print_final_status can emit the
# non-blocking override warning. Outside a git repo it is a no-op (gated on
# `git rev-parse --show-toplevel`, the same gate detect_preexisting_gan_dir and
# prepare_zones use).
#
# READ-ONLY: a single `[ -f ... ] && [ ! -L ... ]` regular-file test against the
# project-tier path. The framework never reads, edits, removes, or migrates the
# project hook — it is the project's file (per H1 § "Project-tier override
# pattern"). The probed path is the repo-top `.claude/hooks/gan-confine.sh`,
# DISTINCT from the user-tier CONFINE_HOOK_PATH (`$HOME/.claude/hooks/...`); the
# two never collide even when the sandboxed $HOME equals the repo top, because
# the repo-top path is resolved from `git rev-parse --show-toplevel` and the
# warning text names the project-relative path explicitly.
#
# Security posture (shell_and_subprocess_safety): no `eval`; every expansion of
# the repo top and the probed path is double-quoted, so a repo path carrying
# spaces or shell metacharacters (`$(...)`, `;`, backticks) is treated purely as
# data by the `[ -f ]`/`[ ! -L ]` test and never re-parsed as a command.
detect_project_tier_confine_hook() {
  PROJECT_TIER_HOOK_DETECTED=""
  local top project_hook
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] || return 0
  project_hook="$top/.claude/hooks/gan-confine.sh"
  # Read-only regular-file probe (never a symlink/dir we would misreport).
  if [ -f "$project_hook" ] && [ ! -L "$project_hook" ]; then
    PROJECT_TIER_HOOK_DETECTED="$project_hook"
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

  if ! claudeagents-config-server --validate-all </dev/null >/dev/null 2>&1; then
    log_warn "ClaudeAgents installer: post-install validate reported issues. Run \`claudeagents-config-server --validate-all\` for details."
  fi
}

# create_builtin_stacks_symlink
#
# Creates `$HOME/.claude/gan/builtin-stacks` as a symlink pointing at the
# globally-installed package's `stacks/` directory (i.e. `<npm root
# -g>/@claudeagents/config-server/stacks/`). The resolver itself does not
# read through this symlink — F1 / C5 compute `<packageRoot>` directly
# from `import.meta.url` — but the symlink gives users a stable,
# predictable path for browsing the framework's canonical stack files
# regardless of where npm installed the package.
#
# Skipped on Windows shells (MSYS / Cygwin / MinGW). Best-effort: if
# `npm root -g` cannot be resolved or the target directory does not exist,
# the function logs a warning and returns 0 so the install does not abort.
# Idempotent: a re-run that finds the same symlink already pointing at
# the right target is a no-op; a stale symlink pointing somewhere else is
# replaced atomically (`ln -sfn`); a real file or directory at the link
# path is left alone with a warning.
create_builtin_stacks_symlink() {
  # Skip on Windows.
  case "$(uname -s)" in
    MINGW*|CYGWIN*|MSYS*)
      return 0
      ;;
  esac

  # Resolve <packageRoot>. Best-effort.
  local npm_root
  if ! npm_root="$(npm root -g 2>/dev/null)" || [ -z "$npm_root" ]; then
    log_warn "Could not resolve npm global root; skipping built-in stacks symlink."
    return 0
  fi

  local pkg_dir="$npm_root/@claudeagents/config-server"
  local target_dir="$pkg_dir/stacks"
  if [ ! -d "$target_dir" ]; then
    log_warn "Built-in stacks directory not found at '$target_dir'; skipping symlink."
    return 0
  fi

  local link_path="$HOME/.claude/gan/builtin-stacks"
  mkdir -p "$HOME/.claude/gan"

  if [ -L "$link_path" ]; then
    local current_target
    current_target="$(readlink "$link_path")"
    if [ "$current_target" = "$target_dir" ]; then
      # Already correct; no-op.
      BUILTIN_STACKS_LINKED=1
      return 0
    fi
    ln -sfn "$target_dir" "$link_path"
    STATE_LOG+=("builtin-stacks-symlink:$link_path")
    BUILTIN_STACKS_LINKED=1
    log_info "Replaced built-in stacks symlink at '$link_path'."
    return 0
  fi

  if [ -e "$link_path" ]; then
    log_warn "A real file or directory exists at '$link_path'; refusing to clobber. Built-in stacks symlink not created."
    return 0
  fi

  ln -s "$target_dir" "$link_path"
  STATE_LOG+=("builtin-stacks-symlink:$link_path")
  BUILTIN_STACKS_LINKED=1
  log_info "Linked built-in stacks at '$link_path'."
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
  log_info "  - Agent and skill files copied under $CLAUDE_HOME/."
  log_info "  - Config server installed and verified on PATH."
  if [ "${SKIP_CLAUDE_CODE:-0}" = "1" ]; then
    log_info "  - Claude Code registration: skipped under \`--no-claude-code\`."
  else
    log_info "  - Claude Code registration written to $CLAUDE_CONFIG_JSON."
  fi
  log_info "  - Repository zones \`.gan-state/\` and \`.gan-cache/\` prepared (when run inside a git repo)."

  if [ "${BUILTIN_STACKS_LINKED:-0}" = "1" ]; then
    printf '  - Built-in stacks linked at %s/.claude/gan/builtin-stacks/.\n' "$HOME"
  fi

  if [ -n "$PREEXISTING_GAN_DIR" ]; then
    log_info ""
    log_info "Heads up: a legacy \`.gan/\` directory exists at $PREEXISTING_GAN_DIR."
    log_info "Delete it by hand once you have copied anything you still need: \`rm -rf $PREEXISTING_GAN_DIR\`."
  fi

  # (H1, AC-A7 / AC-M2) Non-blocking informational override warning. Emitted
  # via the same log_info status surface the rest of this block uses — never
  # log_warn/die — so a detected project-tier hook does not fail or block the
  # install (it still exits 0 with the user-tier hook + registration written).
  # Wording is the canonical text fixed in H1 § "Project-tier override
  # pattern"; the appended `gan hooks status` recommendation is backtick-wrapped
  # per F4 token discipline. Refers to "the framework" / "user-tier hook", names
  # no runtime, and uses a path/command the user inspects (shell-style
  # remediation) — no Node-style `npm run ...`.
  if [ -n "$PROJECT_TIER_HOOK_DETECTED" ]; then
    log_info ""
    log_info "A project-tier confinement hook is present at \`.claude/hooks/gan-confine.sh\`. The framework's user-tier hook at \`~/.claude/hooks/gan-confine.sh\` will not be used in this project. Verify the project hook still reflects the framework's current zone layout (see F1)."
    log_info "Inspect both tiers with \`gan hooks status\`."
  fi

  if [ "$MIDPIVOT_WARNING_FIRED" -eq 1 ]; then
    log_info ""
    log_info "Heads up: you are installing from the \`feature/stack-plugin-rfc\` branch."
    log_info "This branch is the mid-pivot RFC work for ClaudeAgents and is not functional end-to-end yet."
    log_info "Switch to the \`main\` branch once the pivot lands if you want a working install."
  fi

  log_info ""
  log_info "Restart Claude Code to pick up the new agents, skills, and config server."
  log_info "After restart, type \`/gan --help\` in any project to get started."
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
      copied-file)
        # Remove a regular file the install copied into ~/.claude/.
        # Only remove if it's still a regular file at the recorded path —
        # if a third party replaced it with a symlink or directory, we
        # leave it alone (rollback should not destroy unrelated state).
        if [ -f "$payload" ] && [ ! -L "$payload" ]; then
          rm -f "$payload" 2>/dev/null || true
        fi
        ;;
      copied-dir)
        # Remove a directory the install copied. Same defensive check —
        # only remove if it's still a real directory (not a symlink, not
        # gone). `rm -rf` is bounded to the recorded path.
        if [ -d "$payload" ] && [ ! -L "$payload" ]; then
          rm -rf "$payload" 2>/dev/null || true
        fi
        ;;
      symlink)
        # Legacy entry kind from pre-copy installs. Retained so a
        # rollback during an upgrade run cleans up older state too.
        if [ -L "$payload" ]; then
          rm -f "$payload" 2>/dev/null || true
        fi
        ;;
      builtin-stacks-symlink)
        if [ -L "$payload" ]; then
          rm -f "$payload"
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
      claude-settings-edited)
        # Symmetric with claude-json-edited above. Created-by-us =
        # remove; pre-existing = restore from preedit copy.
        if [ "$payload" = "NEW" ]; then
          rm -f "$CLAUDE_SETTINGS_JSON" 2>/dev/null || true
        else
          if [ -f "$payload" ]; then
            mv "$payload" "$CLAUDE_SETTINGS_JSON" 2>/dev/null || true
          fi
        fi
        ;;
      confine-hook-written)
        # (H1) Remove the framework-owned confinement hook this run wrote.
        # Same defensive guard as copied-file: only remove if it is still a
        # regular (non-symlink) file at the recorded path — if a third party
        # replaced it with a symlink or directory, leave it alone. The hook's
        # settings.json registration is restored/removed separately by the
        # claude-settings-edited case (the preedit snapshot was taken before
        # the registration merge), so this case only undoes the hook file.
        if [ -f "$payload" ] && [ ! -L "$payload" ]; then
          rm -f "$payload" 2>/dev/null || true
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
#   - (H1, AC-A5) Removes the user-tier confinement hook file at
#     CONFINE_HOOK_PATH (`~/.claude/hooks/gan-confine.sh`) and surgically
#     strips its `hooks.PreToolUse[]` registration from
#     `~/.claude/settings.json` (matched by the same absolute-hook-path
#     `mentionsHook` predicate the registration used). Unrelated PreToolUse
#     entries and all other settings survive. A project-tier
#     `<project>/.claude/hooks/gan-confine.sh` in the cwd is the project's
#     file and is never touched.
#   - Leaves `.gan-state/`, `.gan-cache/`, `.claude/gan/`, the
#     once-per-machine backup, and the globally installed framework
#     package alone. Prints follow-up commands in backticks so the
#     user can clean those up by hand.
# Idempotent: a second invocation against an already-uninstalled HOME
# exits 0 with the same follow-up hints.
uninstall_main() {
  log_info "ClaudeAgents installer: uninstalling."

  local removed_count=0
  local entry name agent_target

  # Remove any framework agent files at `~/.claude/agents/<name>.md`
  # whose name matches a file in `$REPO_ROOT/agents/`. We use the
  # source-repo file list as the authoritative inventory of what the
  # framework owns; this avoids guessing prefixes. Both real-file
  # (post-copy install) and legacy-symlink entries are removed.
  if [ -d "$CLAUDE_HOME/agents" ] && [ -d "$REPO_ROOT/agents" ]; then
    shopt -s nullglob
    for entry in "$REPO_ROOT/agents/"*.md; do
      name="$(basename "$entry")"
      agent_target="$CLAUDE_HOME/agents/$name"
      if [ -L "$agent_target" ] || [ -f "$agent_target" ]; then
        rm -f "$agent_target"
        removed_count=$(( removed_count + 1 ))
      fi
    done
    shopt -u nullglob
  fi

  # Remove `~/.claude/skills/gan/` whether it is a directory copy
  # (post-copy install) or a legacy symlink.
  if [ -L "$CLAUDE_HOME/skills/gan" ]; then
    rm -f "$CLAUDE_HOME/skills/gan"
    removed_count=$(( removed_count + 1 ))
  elif [ -d "$CLAUDE_HOME/skills/gan" ]; then
    rm -rf "$CLAUDE_HOME/skills/gan"
    removed_count=$(( removed_count + 1 ))
  fi

  # (H1, AC-A5) Remove the framework-owned user-tier confinement hook file at
  # CONFINE_HOOK_PATH (`$HOME/.claude/hooks/gan-confine.sh`). Same defensive
  # guard the agent-removal and rollback paths use: remove only when it is a
  # regular non-symlink file at the recorded user-tier path — a symlink/dir a
  # third party put there is left alone. Scoped to the user-tier path ONLY; a
  # project-tier `<repo>/.claude/hooks/gan-confine.sh` in the cwd is the
  # project's file and is never touched. Idempotent: a second uninstall against
  # an already-clean HOME finds nothing here and removes nothing.
  if [ -f "$CONFINE_HOOK_PATH" ] && [ ! -L "$CONFINE_HOOK_PATH" ]; then
    rm -f "$CONFINE_HOOK_PATH"
    removed_count=$(( removed_count + 1 ))
  fi

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

  # Strip framework-added entries from `~/.claude/settings.json`'s
  # `permissions.allow` array. Only entries that match the catalog
  # (CATEGORIES_JSON's tools across every category) are removed; any
  # user-authored entry that happens to coexist is preserved. The
  # surgical removal closes the I2 acceptance criterion: "removes only
  # the entries matching the framework's category templates".
  if [ -f "$CLAUDE_SETTINGS_JSON" ]; then
    local settings_tmp="$CLAUDE_SETTINGS_JSON.tmp.$$"
    CLAUDE_SETTINGS_PATH="$CLAUDE_SETTINGS_JSON" \
    CLAUDE_SETTINGS_TMP="$settings_tmp" \
    CLAUDE_CATEGORIES_JSON="$CATEGORIES_JSON" \
    node -e '
      const fs = require("fs");
      const src = process.env.CLAUDE_SETTINGS_PATH;
      const dst = process.env.CLAUDE_SETTINGS_TMP;
      const cats = JSON.parse(process.env.CLAUDE_CATEGORIES_JSON);
      const owned = new Set();
      for (const cat of cats) {
        if (Array.isArray(cat.tools)) for (const t of cat.tools) owned.add(t);
      }
      let data = {};
      const raw = fs.readFileSync(src, "utf8");
      if (raw.trim().length > 0) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error("install.sh: ~/.claude/settings.json is not valid JSON: " + e.message);
          process.exit(1);
        }
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          console.error("install.sh: ~/.claude/settings.json must be a JSON object.");
          process.exit(1);
        }
      }
      if (
        data &&
        typeof data.permissions === "object" &&
        data.permissions !== null &&
        Array.isArray(data.permissions.allow)
      ) {
        data.permissions.allow = data.permissions.allow.filter((t) => !owned.has(String(t)));
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
    mv "$settings_tmp" "$CLAUDE_SETTINGS_JSON"
  fi

  # (H1, AC-A5) Surgically strip the framework's `hooks.PreToolUse[]`
  # registration from `~/.claude/settings.json`, symmetric with the
  # permissions.allow strip above. An independent atomic edit: it reads the file
  # the previous edit just wrote, so the two never collide. The match predicate
  # is the SAME `mentionsHook` shape write_confine_hook used to register the
  # entry — an entry whose top-level `command` equals the absolute hook path, OR
  # an entry whose nested `hooks[].command` equals it. Only matching entries are
  # removed; unrelated user-authored PreToolUse entries (different command) and
  # all other settings survive byte-for-byte. The match is structural on the
  # command path (never substring matching on raw content), so adversarial
  # settings cannot widen the blast radius. R2-locked node -e + atomic
  # temp+rename + sorted-key + 2-space-indent + trailing-newline (no jq);
  # malformed settings.json exits 1 with framework prose. Empty arrays/objects
  # left after removal are acceptable, matching the permissions.allow precedent.
  if [ -f "$CLAUDE_SETTINGS_JSON" ]; then
    # Resolve the user-tier hook path to the same real absolute path the
    # registration carried (the constant is already absolute/`~`-free, but
    # resolve its parent dir defensively when it exists so the strip predicate
    # matches the registration's entry exactly).
    local hooks_dir hook_abs
    hooks_dir="$(dirname "$CONFINE_HOOK_PATH")"
    if [ -d "$hooks_dir" ]; then
      hook_abs="$(cd "$hooks_dir" && pwd)/$(basename "$CONFINE_HOOK_PATH")"
    else
      hook_abs="$CONFINE_HOOK_PATH"
    fi
    local pretooluse_tmp="$CLAUDE_SETTINGS_JSON.tmp.$$"
    CLAUDE_SETTINGS_PATH="$CLAUDE_SETTINGS_JSON" \
    CLAUDE_SETTINGS_TMP="$pretooluse_tmp" \
    CONFINE_HOOK_ABS="$hook_abs" \
    node -e '
      const fs = require("fs");
      const src = process.env.CLAUDE_SETTINGS_PATH;
      const dst = process.env.CLAUDE_SETTINGS_TMP;
      const hookAbs = process.env.CONFINE_HOOK_ABS;
      let data = {};
      const raw = fs.readFileSync(src, "utf8");
      if (raw.trim().length > 0) {
        try {
          data = JSON.parse(raw);
        } catch (e) {
          console.error("install.sh: ~/.claude/settings.json is not valid JSON: " + e.message);
          process.exit(1);
        }
        if (data === null || typeof data !== "object" || Array.isArray(data)) {
          console.error("install.sh: ~/.claude/settings.json must be a JSON object.");
          process.exit(1);
        }
      }
      // Same mentionsHook predicate the registration used: a top-level
      // command === hookAbs, OR a nested hooks[].command === hookAbs. We keep
      // every entry that does NOT mention the framework hook.
      const mentionsHook = (entry) => {
        if (!entry || typeof entry !== "object") return false;
        if (entry.command === hookAbs) return true;
        if (Array.isArray(entry.hooks)) {
          return entry.hooks.some((h) => h && typeof h === "object" && h.command === hookAbs);
        }
        return false;
      };
      if (
        data &&
        typeof data.hooks === "object" &&
        data.hooks !== null &&
        !Array.isArray(data.hooks) &&
        Array.isArray(data.hooks.PreToolUse)
      ) {
        data.hooks.PreToolUse = data.hooks.PreToolUse.filter((e) => !mentionsHook(e));
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
    mv "$pretooluse_tmp" "$CLAUDE_SETTINGS_JSON"
  fi

  # Remove the built-in stacks symlink only when it points into the
  # globally-installed framework package. Symlinks the user has redirected
  # somewhere else are left alone.
  local builtin_link="$HOME/.claude/gan/builtin-stacks"
  if [ -L "$builtin_link" ]; then
    local current_target
    current_target="$(readlink "$builtin_link")"
    local npm_root
    if npm_root="$(npm root -g 2>/dev/null)" && [ -n "$npm_root" ]; then
      local expected_prefix="$npm_root/@claudeagents/config-server"
      case "$current_target" in
        "$expected_prefix"|"$expected_prefix"/*)
          rm -f "$builtin_link"
          ;;
        *)
          log_warn "Built-in stacks symlink at '$builtin_link' points elsewhere; leaving alone."
          ;;
      esac
    fi
  fi

  # Remove the globally installed npm package. The package is namespaced
  # (`@claudeagents/config-server`) and ships only the framework's two
  # bins (`claudeagents-config-server`, `gan`); nothing outside the
  # framework can reasonably depend on it. Leaving it in place after
  # uninstall would mean `gan` and `claudeagents-config-server` stay on
  # PATH — directly contradicting the user's intent to uninstall.
  #
  # If `npm uninstall -g` fails (permissions, npm not on PATH, network
  # registry unreachable), we warn but do not fail the uninstall — the
  # filesystem state is already cleaned up; the leftover npm package is
  # the smaller residual.
  local npm_pkg="@claudeagents/config-server"
  local npm_removed=0
  if command -v npm >/dev/null 2>&1; then
    if npm uninstall -g "$npm_pkg" >/dev/null 2>&1; then
      npm_removed=1
    else
      log_warn "Could not remove the globally installed package \`$npm_pkg\`. Run \`npm uninstall -g $npm_pkg\` by hand to clean up."
    fi
  else
    log_warn "\`npm\` is not on PATH; cannot remove the globally installed package \`$npm_pkg\`. Run \`npm uninstall -g $npm_pkg\` once npm is available."
  fi

  log_info ""
  log_info "ClaudeAgents installer: uninstall complete."
  log_info "  - Removed $removed_count framework file(s) from $CLAUDE_HOME/."
  log_info "  - Cleared the framework entry from $CLAUDE_CONFIG_JSON (when present)."
  if [ "$npm_removed" -eq 1 ]; then
    log_info "  - Removed the globally installed package \`$npm_pkg\` (\`gan\` and \`claudeagents-config-server\` are no longer on PATH)."
  fi
  log_info ""
  log_info "Left in place:"
  log_info "  - Per-project zones: \`rm -rf .gan-state .gan-cache\` (run from each repo) if you want them gone."
  log_info "  - Project overlays under \`.claude/gan/\` and the once-per-machine \`~/.claude.json\` backup are untouched."
}

main() {
  local mode="install"
  # Globals (not locals) because `print_final_status` reads them after
  # `main()` has handed control off; using a local would force a
  # parameter-threading rewrite of the whole final-status block.
  SKIP_CLAUDE_CODE=0
  # Permission-flow flags consumed by `configure_permissions`. Globals
  # rather than parameters because configure_permissions also reads
  # CATEGORIES_JSON / CLAUDE_SETTINGS_JSON from globals.
  PERMISSION_MODE=""
  RECONFIGURE_PERMISSIONS=0

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
        SKIP_CLAUDE_CODE=1
        ;;
      --approve-all-permissions)
        if [ "$PERMISSION_MODE" = "minimal" ]; then
          die "\`--approve-all-permissions\` and \`--minimal-permissions\` are mutually exclusive. Pass at most one."
        fi
        PERMISSION_MODE="approve-all"
        ;;
      --minimal-permissions)
        if [ "$PERMISSION_MODE" = "approve-all" ]; then
          die "\`--approve-all-permissions\` and \`--minimal-permissions\` are mutually exclusive. Pass at most one."
        fi
        PERMISSION_MODE="minimal"
        ;;
      --reconfigure-permissions)
        RECONFIGURE_PERMISSIONS=1
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
  # Bash 4.4 changed the default: `set -e` no longer propagates into
  # command substitution (`$(...)`) subshells unless `inherit_errexit`
  # is set explicitly. macOS system bash (3.2) inherited unconditionally.
  # We need the bash-3.2 behaviour so a failure inside e.g.
  # `out=$(npm install -g .)` aborts the subshell and routes through
  # the ERR trap. Quietly succeed on bash 3.2 (where the option does
  # not exist and the inherit-by-default behaviour already applies) by
  # swallowing the unknown-option error.
  shopt -s inherit_errexit 2>/dev/null || true
  trap on_error ERR

  feature_branch_warning

  check_node
  check_git
  if [ "$SKIP_CLAUDE_CODE" -eq 0 ]; then
    check_claude_code
  fi

  log_info "ClaudeAgents installer: prerequisites verified."

  # Read the package.json version once; the version-probe compares
  # against this when deciding whether to run `npm install -g .`.
  local package_version probe_version
  package_version="$(read_mcp_server_version)"

  prune_stale_agent_symlinks
  install_agents_and_skills

  probe_version="$(version_probe_mcp)"
  if [ -z "$probe_version" ] || [ "$probe_version" != "$package_version" ]; then
    install_mcp_server
  fi

  # Verify the bin shim landed on PATH. See `verify_mcp_bin_on_path`'s
  # docstring for why this is a helper (rather than inlined here).
  verify_mcp_bin_on_path

  if [ "$SKIP_CLAUDE_CODE" -eq 0 ]; then
    backup_claude_json_once
    register_mcp_in_claude_json
    # (H1) Render + write the framework-owned confinement hook and register it
    # in settings.json. Runs before configure_permissions so its settings
    # preedit snapshot covers the run's first settings.json edit, letting the
    # existing claude-settings-edited rollback case restore the registration.
    write_confine_hook
    configure_permissions
  fi

  detect_preexisting_gan_dir
  # (H1) Detect a project-tier confinement hook so print_final_status can warn
  # that it takes precedence over the framework's user-tier hook. Read-only and
  # non-blocking — it never touches the project file and never fails the install.
  detect_project_tier_confine_hook
  prepare_zones
  run_validate_all_best_effort

  create_builtin_stacks_symlink

  # Every state-creating step has succeeded — disarm the rollback trap
  # and remove the per-run preedit copies of `~/.claude.json` and
  # `~/.claude/settings.json` (if any).
  trap - ERR
  if [ -n "$PREEDIT_CLAUDE_JSON" ] && [ -f "$PREEDIT_CLAUDE_JSON" ]; then
    rm -f "$PREEDIT_CLAUDE_JSON"
  fi
  if [ -n "$PREEDIT_CLAUDE_SETTINGS" ] && [ -f "$PREEDIT_CLAUDE_SETTINGS" ]; then
    rm -f "$PREEDIT_CLAUDE_SETTINGS"
  fi

  print_final_status
  exit 0
}

main "$@"
