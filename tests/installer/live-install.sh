#!/usr/bin/env bash
#
# Live, non-stubbed install.sh round-trip test. Intended for pre-release
# verification, NOT for the routine `npm test` sweep.
#
# The vitest suite at `tests/installer/install.test.ts` uses stubbed `npm`
# and `claudeagents-config-server` binaries, so it verifies the shell
# logic in `install.sh` but never actually places the package on PATH or
# runs the real `claudeagents-config-server` binary. This script does
# both — it exercises the real `npm install -g .`, the real binary, and
# the real disk-state side-effects of every flag combination.
#
# Coverage is intentionally limited to scenarios reproducible with the
# real environment plus flag combinations and PATH manipulation. Failure
# modes that require fake binaries (e.g. `npm install` failure, old
# `node` version) are NOT covered here — those are in the vitest suite.
#
# Run with:
#
#   npm run test:install:live
#
# or directly:
#
#   bash tests/installer/live-install.sh
#
# Exits 0 on full pass, non-zero on any failure. Cleans up sandboxes on
# exit and reinstalls the global npm package (the `--uninstall` tests
# remove it).

set -u

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
INSTALL_SH="$REPO_ROOT/install.sh"
[ -f "$INSTALL_SH" ] || { echo "FATAL: cannot locate install.sh at $INSTALL_SH" >&2; exit 2; }

PASS=0
FAIL=0
FAIL_NAMES=()
SBX_ROOT=$(mktemp -d -t gan-live-install)

cleanup() {
  rm -rf "$SBX_ROOT"
  # Restore the global package — --uninstall tests remove it, and we
  # must not leave the user's PATH broken.
  ( cd "$REPO_ROOT" && npm install -g . > /dev/null 2>&1 ) || true
}
trap cleanup EXIT

ok()  { printf "  ✅ %s\n" "$1"; PASS=$((PASS+1)); }
bad() { printf "  ❌ %s\n      %s\n" "$1" "$2"; FAIL=$((FAIL+1)); FAIL_NAMES+=("$1"); }
hdr() { printf "\n=== %s ===\n" "$1"; }

new_sbx() { mktemp -d "$SBX_ROOT/sbx.XXXX"; }

# Strip `claude` from PATH for the missing-claude tests, but keep
# everything else the binary needs (node, npm, git).
PATH_NO_CLAUDE="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Strip both `claude` and `node` for the node-missing test. Keep `git`
# and core POSIX tools — install.sh uses /usr/bin/git via the system.
PATH_NO_NODE="/usr/bin:/bin:/usr/sbin:/sbin"

############################################################################
# Strong-state helpers. Every successful install should pass both.
############################################################################

# Verifies that a successful install left every documented artifact
# on disk under $1 (= $HOME for the test). Returns 0 if all artifacts
# present, prints the first missing artifact and returns 1 otherwise.
assert_install_artifacts() {
  local sbx="$1"
  local f
  for f in "$REPO_ROOT/agents"/*.md; do
    local name
    name="$(basename "$f")"
    if [ ! -f "$sbx/.claude/agents/$name" ]; then
      printf "      missing agent: %s\n" "$name"
      return 1
    fi
  done
  if [ ! -f "$sbx/.claude/skills/gan/SKILL.md" ]; then
    printf "      missing skill: skills/gan/SKILL.md\n"
    return 1
  fi
  if [ ! -L "$sbx/.claude/gan/builtin-stacks" ]; then
    printf "      missing symlink: .claude/gan/builtin-stacks\n"
    return 1
  fi
  if [ ! -d "$sbx/.claude/gan/builtin-stacks" ]; then
    printf "      built-in stacks symlink does not resolve\n"
    return 1
  fi
  # No leftover atomic-write tmps or preedit copies — these would
  # indicate a partially-completed write that should have been cleaned up
  # by either successful rename or the rollback handler.
  if compgen -G "$sbx/.claude/*.tmp.*" > /dev/null 2>&1; then
    printf "      stray tmp file: %s\n" "$(compgen -G "$sbx/.claude/*.tmp.*" | head -1)"
    return 1
  fi
  if compgen -G "$sbx/.claude/*.preedit-*" > /dev/null 2>&1; then
    printf "      stray preedit copy: %s\n" "$(compgen -G "$sbx/.claude/*.preedit-*" | head -1)"
    return 1
  fi
  if compgen -G "$sbx/.claude.json.preedit-*" > /dev/null 2>&1; then
    printf "      stray .claude.json preedit copy\n"
    return 1
  fi
  return 0
}

# Verifies the MCP registration in $sbx/.claude.json: must have an entry
# at `mcpServers["claudeagents-config"]` with an absolute command path,
# empty args, and an object env. Returns 0 on success.
assert_mcp_registration() {
  local sbx="$1"
  if [ ! -f "$sbx/.claude.json" ]; then
    printf "      missing .claude.json\n"
    return 1
  fi
  if ! node -e "
    const d = JSON.parse(require('fs').readFileSync('$sbx/.claude.json','utf8'));
    const e = d && d.mcpServers && d.mcpServers['claudeagents-config'];
    if (!e) { console.error('no claudeagents-config entry'); process.exit(1); }
    if (typeof e.command !== 'string' || !require('path').isAbsolute(e.command)) {
      console.error('command is not absolute path: ' + e.command); process.exit(1);
    }
    if (!Array.isArray(e.args) || e.args.length !== 0) {
      console.error('args not empty array'); process.exit(1);
    }
    if (e.env === null || typeof e.env !== 'object' || Array.isArray(e.env)) {
      console.error('env not object'); process.exit(1);
    }
  " 2>&1 | sed 's/^/      /'; then
    return 1
  fi
  return 0
}

# Verifies that no install side-effect was left on disk under $1. Used
# after error-exit cases that should leave HOME untouched (either fully
# rolled back, or never written in the first place).
assert_no_install_artifacts() {
  local sbx="$1"
  if [ -d "$sbx/.claude/agents" ] && [ -n "$(ls -A "$sbx/.claude/agents" 2>/dev/null)" ]; then
    printf "      agents directory unexpectedly populated\n"
    return 1
  fi
  if [ -d "$sbx/.claude/skills/gan" ]; then
    printf "      skill directory unexpectedly created\n"
    return 1
  fi
  if [ -f "$sbx/.claude.json" ]; then
    printf "      .claude.json unexpectedly created\n"
    return 1
  fi
  return 0
}

############################################################################
hdr "A. Argument handling"
############################################################################

# A1: --help prints usage and names every documented flag.
out=$("$INSTALL_SH" --help 2>&1); rc=$?
expected_flags=(--help --uninstall --no-claude-code --approve-all-permissions --minimal-permissions --reconfigure-permissions)
missing=""
for flag in "${expected_flags[@]}"; do
  echo "$out" | grep -q -- "$flag" || missing="$missing $flag"
done
if [ "$rc" -eq 0 ] && [ -z "$missing" ] && echo "$out" | grep -q "Usage:"; then
  ok "A1 --help names every documented flag and exits 0"
else
  bad "A1 --help" "rc=$rc, missing flags:$missing"
fi

# A2: Unknown flag is rejected, no side effects on HOME.
sbx=$(new_sbx)
out=$(HOME=$sbx "$INSTALL_SH" --bogus-flag 2>&1); rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -qiE "unknown|unrecognised|unrecognized"; then
  if assert_no_install_artifacts "$sbx"; then
    ok "A2 unknown flag rejected, no side effects (rc=$rc)"
  else
    bad "A2 unknown flag" "rc=$rc but install artifacts present"
  fi
else
  bad "A2 unknown flag" "rc=$rc, out=${out:0:120}"
fi

# A3: Mutual exclusion (both --approve-all and --minimal). Output must
# name both flag strings. No side effects.
sbx=$(new_sbx)
out=$(HOME=$sbx "$INSTALL_SH" --approve-all-permissions --minimal-permissions 2>&1); rc=$?
if [ "$rc" -ne 0 ] && \
   echo "$out" | grep -q "mutually exclusive" && \
   echo "$out" | grep -q -- "--approve-all-permissions" && \
   echo "$out" | grep -q -- "--minimal-permissions" && \
   assert_no_install_artifacts "$sbx"; then
  ok "A3 mutual exclusion: error names both flags, no side effects"
else
  bad "A3 mutual exclusion" "rc=$rc, out=${out:0:200}"
fi

############################################################################
hdr "B. Prerequisite checks (no fake binaries — PATH manipulation only)"
############################################################################

# B2: `node` missing from PATH (PATH=/usr/bin:/bin only). Should error
# and leave HOME untouched.
sbx=$(new_sbx)
out=$(HOME=$sbx PATH="$PATH_NO_NODE" "$INSTALL_SH" --no-claude-code 2>&1); rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -qi "node"; then
  if assert_no_install_artifacts "$sbx"; then
    ok "B2 node missing → error, no side effects"
  else
    bad "B2 node missing" "errored but left artifacts"
  fi
else
  bad "B2 node missing" "rc=$rc, out=${out:0:200}"
fi

# B3: `claude` missing without --no-claude-code → error, no side effects.
sbx=$(new_sbx)
out=$(HOME=$sbx PATH="$PATH_NO_CLAUDE" "$INSTALL_SH" 2>&1); rc=$?
if [ "$rc" -ne 0 ] && echo "$out" | grep -q "Claude Code.*PATH" && \
   assert_no_install_artifacts "$sbx"; then
  ok "B3 claude missing without --no-claude-code → error, no side effects"
else
  bad "B3 claude missing" "rc=$rc, out=${out:0:200}"
fi

# B4: claude missing WITH --no-claude-code → install succeeds. Verify
# the full artifact set landed and `.claude.json` was NOT written (per
# --no-claude-code's contract).
sbx=$(new_sbx)
HOME=$sbx PATH="$PATH_NO_CLAUDE" "$INSTALL_SH" --no-claude-code --minimal-permissions > /dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && assert_install_artifacts "$sbx" && \
   [ ! -f "$sbx/.claude.json" ] && [ ! -f "$sbx/.claude/settings.json" ]; then
  ok "B4 --no-claude-code: agents/skills/symlink present; no .claude.json or settings.json"
else
  bad "B4 --no-claude-code" "rc=$rc; check artifacts manually at $sbx"
fi

############################################################################
hdr "C. Happy paths — strong disk-state assertions"
############################################################################

# C1: --approve-all-permissions. Every category's tools merged into
# permissions.allow; full artifact set; .claude.json registered.
sbx=$(new_sbx)
HOME=$sbx "$INSTALL_SH" --approve-all-permissions > /dev/null 2>&1
rc=$?
n=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8')).permissions.allow.length)" 2>/dev/null)
if [ "$rc" -eq 0 ] && [ "$n" = "31" ] && assert_install_artifacts "$sbx" && assert_mcp_registration "$sbx"; then
  ok "C1 --approve-all-permissions: 31 entries + full artifacts + MCP entry"
else
  bad "C1 approve-all" "rc=$rc, entries=$n"
fi

# C2: --minimal-permissions. Single category-1 entry, full artifacts,
# MCP entry present.
sbx=$(new_sbx)
HOME=$sbx "$INSTALL_SH" --minimal-permissions > /dev/null 2>&1
rc=$?
got=$(node -e "
  const d=JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8'));
  console.log(d.permissions.allow.length + ':' + d.permissions.allow[0]);
" 2>/dev/null)
if [ "$rc" -eq 0 ] && [ "$got" = "1:mcp__claudeagents-config__*" ] && \
   assert_install_artifacts "$sbx" && assert_mcp_registration "$sbx"; then
  ok "C2 --minimal-permissions: only framework MCP entry + full artifacts"
else
  bad "C2 minimal-permissions" "rc=$rc, got=$got"
fi

# C3: --no-claude-code + --minimal-permissions. No .claude.json, no
# settings.json; agents and skills still copied.
sbx=$(new_sbx)
HOME=$sbx "$INSTALL_SH" --no-claude-code --minimal-permissions > /dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ ! -f "$sbx/.claude.json" ] && [ ! -f "$sbx/.claude/settings.json" ] && \
   assert_install_artifacts "$sbx"; then
  ok "C3 --no-claude-code: full artifacts; .claude.json and settings.json absent"
else
  bad "C3 --no-claude-code" "rc=$rc"
fi

# C4: Idempotency on re-run. Entry count unchanged; full artifacts
# preserved; no leftover tmp files from the second run.
sbx=$(new_sbx)
HOME=$sbx "$INSTALL_SH" --approve-all-permissions > /dev/null 2>&1
n1=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8')).permissions.allow.length)")
HOME=$sbx "$INSTALL_SH" --approve-all-permissions > /dev/null 2>&1
rc=$?
n2=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8')).permissions.allow.length)")
if [ "$rc" -eq 0 ] && [ "$n1" = "$n2" ] && [ "$n2" = "31" ] && assert_install_artifacts "$sbx"; then
  ok "C4 idempotency: re-run keeps 31 entries, full artifacts intact"
else
  bad "C4 idempotency" "rc=$rc n1=$n1 n2=$n2"
fi

# C5: --reconfigure-permissions actually re-prompts vs. skipping.
# Strong test: first install with --minimal-permissions (1 entry).
# Then run with `--reconfigure-permissions --approve-all-permissions`:
# without `--reconfigure`, the already-granted category 1 would be
# skipped but the other 7 would still add. With `--reconfigure`, every
# category is re-evaluated and all 31 entries land. The expected count
# is the same in both cases (31). The behavioural difference is the
# "already granted; skipping." line — it must NOT appear under
# --reconfigure.
sbx=$(new_sbx)
HOME=$sbx "$INSTALL_SH" --minimal-permissions > /dev/null 2>&1
out=$(HOME=$sbx "$INSTALL_SH" --reconfigure-permissions --approve-all-permissions 2>&1)
rc=$?
n=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8')).permissions.allow.length)")
if [ "$rc" -eq 0 ] && [ "$n" = "31" ] && ! echo "$out" | grep -q "already granted; skipping"; then
  ok "C5 --reconfigure-permissions re-evaluates every category (no 'already granted' lines, 31 final entries)"
else
  bad "C5 reconfigure" "rc=$rc, entries=$n, 'already granted' lines=$(echo "$out" | grep -c "already granted")"
fi

############################################################################
hdr "D. State preservation and uninstall"
############################################################################

# D1: User-authored permission survives install merge. Full artifacts
# still land.
sbx=$(new_sbx)
mkdir -p "$sbx/.claude"
cat > "$sbx/.claude/settings.json" <<'JSON'
{
  "permissions": {
    "allow": [
      "Bash(my-custom-tool:*)"
    ]
  }
}
JSON
HOME=$sbx "$INSTALL_SH" --approve-all-permissions > /dev/null 2>&1
rc=$?
has_user=$(node -e "
  const d=JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8'));
  console.log(d.permissions.allow.includes('Bash(my-custom-tool:*)'));
")
n=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8')).permissions.allow.length)")
if [ "$rc" -eq 0 ] && [ "$has_user" = "true" ] && [ "$n" = "32" ] && assert_install_artifacts "$sbx"; then
  ok "D1 user entry survives merge (final count 32 = 31 framework + 1 user)"
else
  bad "D1 user-entry preservation" "rc=$rc has_user=$has_user count=$n"
fi

# D2: --uninstall strips ONLY framework entries; preserves user entry;
# removes agents/skills/symlink; clears the .claude.json registration
# entry.
out=$(HOME=$sbx "$INSTALL_SH" --uninstall 2>&1)
rc=$?
remaining=$(node -e "
  const d=JSON.parse(require('fs').readFileSync('$sbx/.claude/settings.json','utf8'));
  console.log(d.permissions.allow.join(','));
")
agents_left=0
if [ -d "$sbx/.claude/agents" ]; then
  agents_left=$(ls "$sbx/.claude/agents" 2>/dev/null | wc -l | tr -d ' ')
fi
mcp_remains="no"
if [ -f "$sbx/.claude.json" ]; then
  mcp_remains=$(node -e "
    const d=JSON.parse(require('fs').readFileSync('$sbx/.claude.json','utf8'));
    console.log(d.mcpServers && d.mcpServers['claudeagents-config'] ? 'yes' : 'no');
  ")
fi
if [ "$rc" -eq 0 ] && [ "$remaining" = "Bash(my-custom-tool:*)" ] && \
   [ "$agents_left" = "0" ] && [ "$mcp_remains" = "no" ]; then
  ok "D2 --uninstall: user entry preserved; agents gone; MCP entry cleared"
else
  bad "D2 uninstall" "rc=$rc remaining='$remaining' agents=$agents_left mcp=$mcp_remains"
fi

# Reinstall the global package — D2 removed it.
( cd "$REPO_ROOT" && npm install -g . > /dev/null 2>&1 ) || true

# D3: --uninstall on empty HOME exits 0 and leaves HOME completely
# untouched. (No partial state creation, no stray dirs.)
sbx=$(new_sbx)
out=$(HOME=$sbx "$INSTALL_SH" --uninstall 2>&1)
rc=$?
created_anything="no"
if [ -d "$sbx/.claude" ] && [ -n "$(ls -A "$sbx/.claude" 2>/dev/null)" ]; then
  created_anything="yes"
fi
if [ -f "$sbx/.claude.json" ]; then
  created_anything="yes (.claude.json)"
fi
if [ "$rc" -eq 0 ] && [ "$created_anything" = "no" ]; then
  ok "D3 --uninstall on empty HOME: rc=0, no stray state created"
else
  bad "D3 uninstall-no-install" "rc=$rc created=$created_anything"
fi

# Reinstall again in case D3 removed the global package.
( cd "$REPO_ROOT" && npm install -g . > /dev/null 2>&1 ) || true

############################################################################
hdr "E. Git-repo behavior"
############################################################################

# E1: Outside a git repo, install succeeds but zones are not created and
# validate is skipped. Agents/skills/MCP entry all still land.
sbx=$(new_sbx); nongit=$(new_sbx)
out=$(cd "$nongit" && HOME=$sbx "$INSTALL_SH" --minimal-permissions 2>&1)
rc=$?
zones_count=$( (cd "$nongit" && ls .gan-state .gan-cache 2>/dev/null) | wc -l | tr -d ' ')
if [ "$rc" -eq 0 ] && [ "$zones_count" = "0" ] && \
   assert_install_artifacts "$sbx" && assert_mcp_registration "$sbx"; then
  ok "E1 outside git repo: install succeeds, no zones, MCP and artifacts intact"
else
  bad "E1 outside-git" "rc=$rc zones=$zones_count"
fi

############################################################################
hdr "G. Output format"
############################################################################

# G1: Final-status names BOTH the restart prompt and the /gan --help hint.
sbx=$(new_sbx)
out=$(HOME=$sbx "$INSTALL_SH" --approve-all-permissions 2>&1)
if echo "$out" | grep -q "Restart Claude Code" && echo "$out" | grep -q "/gan --help"; then
  ok "G1 final-status names both restart and \`/gan --help\` hint"
else
  bad "G1 final-status hints" "missing one or both"
fi

# G2: settings.json is sorted-key with 2-space indent and trailing newline.
sbx=$(new_sbx)
HOME=$sbx "$INSTALL_SH" --approve-all-permissions > /dev/null 2>&1
fmt=$(node -e "
  const fs=require('fs');
  const raw=fs.readFileSync('$sbx/.claude/settings.json','utf8');
  const d=JSON.parse(raw);
  const sortKeys = (v) => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      const o={};
      for (const k of Object.keys(v).sort()) o[k]=sortKeys(v[k]);
      return o;
    }
    return v;
  };
  const expected=JSON.stringify(sortKeys(d), null, 2)+'\n';
  if (raw === expected) console.log('OK');
  else console.log('MISMATCH');
")
if [ "$fmt" = "OK" ]; then
  ok "G2 settings.json byte-equal to sorted-key + 2-space + trailing newline"
else
  bad "G2 format" "byte mismatch"
fi

# G3: --no-claude-code final-status correctly reads as "skipped".
sbx=$(new_sbx)
out=$(HOME=$sbx "$INSTALL_SH" --no-claude-code --minimal-permissions 2>&1)
if echo "$out" | grep -q "Claude Code registration: skipped under"; then
  ok "G3 --no-claude-code final-status correctly reads 'skipped'"
else
  bad "G3 final-status with --no-claude-code" "got: $(echo "$out" | grep -i 'claude code registration')"
fi

# G4: Normal install final-status reads "written to <path>" with no
# bogus 'skipped' suffix.
sbx=$(new_sbx)
out=$(HOME=$sbx "$INSTALL_SH" --approve-all-permissions 2>&1)
if echo "$out" | grep -q "Claude Code registration written to" && \
   ! echo "$out" | grep -qE "Claude Code registration written to.*skipped"; then
  ok "G4 normal install final-status reads cleanly (no bogus 'skipped' suffix)"
else
  bad "G4 final-status normal" "got: $(echo "$out" | grep -i 'claude code registration')"
fi

############################################################################
hdr "Not covered here (requires special fixtures or a real TTY)"
############################################################################
printf "  - Interactive 8-category prompt UX (Y/n/v/a/s shortcuts) — needs a pty.\n"
printf "  - Old node version warning (warn-not-die) — needs a fake node stub.\n"
printf "  - npm install failure rollback (S2-AC10) — needs a fake npm stub.\n"
printf "  - Missing build artifact at dist/ — needs the package to be globally\n"
printf "    installed without dist/, which the vitest suite covers.\n"
printf "  These are exercised by the vitest suite in tests/installer/.\n"

############################################################################
hdr "SUMMARY"
############################################################################
printf "\nPassed: %d\nFailed: %d\n" "$PASS" "$FAIL"
if [ "${#FAIL_NAMES[@]}" -gt 0 ]; then
  printf "\nFailures:\n"
  printf "  - %s\n" "${FAIL_NAMES[@]}"
fi

[ "$FAIL" -eq 0 ]
