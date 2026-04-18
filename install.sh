#!/bin/bash
# Install (or verify) GAN agents and skills into ~/.claude/
# Creates symlinks so edits in this repo are reflected immediately.
#
# Usage:
#   ./install.sh           # install / refresh symlinks
#   ./install.sh --check   # verify existing symlinks still point back into this repo

set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$HOME/.claude"

MODE="install"
if [ "${1:-}" = "--check" ]; then
  MODE="check"
elif [ -n "${1:-}" ]; then
  echo "Unknown argument: $1"
  echo "Usage: $0 [--check]"
  exit 2
fi

if [ "$MODE" = "check" ]; then
  echo "Checking symlinks in: $CLAUDE"
  echo "Expected repo:        $REPO"
  echo ""

  broken=0
  missing=0
  foreign=0

  check_target () {
    local src="$1"
    local link="$2"
    local label="$3"

    if [ ! -e "$src" ]; then
      return
    fi

    if [ ! -e "$link" ] && [ ! -L "$link" ]; then
      echo "  ✗  $label  (missing — run ./install.sh to create)"
      missing=$((missing + 1))
      return
    fi

    if [ ! -L "$link" ]; then
      echo "  ⚠  $label  (exists but is not a symlink)"
      foreign=$((foreign + 1))
      return
    fi

    local resolved
    resolved="$(readlink "$link")"
    if [ "$resolved" != "$src" ]; then
      echo "  ✗  $label  (points to $resolved, expected $src)"
      broken=$((broken + 1))
      return
    fi

    if [ ! -e "$link" ]; then
      echo "  ✗  $label  (dangling symlink → $resolved)"
      broken=$((broken + 1))
      return
    fi

    echo "  ✓  $label"
  }

  for f in "$REPO/agents/"*.md; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    check_target "$f" "$CLAUDE/agents/$name" "agents/$name"
  done

  for dir in "$REPO/skills/"*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    src="${dir%/}"
    check_target "$src" "$CLAUDE/skills/$name" "skills/$name"
  done

  echo ""
  if [ "$broken" -eq 0 ] && [ "$missing" -eq 0 ] && [ "$foreign" -eq 0 ]; then
    echo "All symlinks healthy."
    exit 0
  fi
  echo "Summary: broken=$broken missing=$missing foreign=$foreign"
  echo "Run ./install.sh to (re)create symlinks."
  exit 1
fi

echo "Installing from: $REPO"
echo "Installing into: $CLAUDE"
echo ""

# Agents
mkdir -p "$CLAUDE/agents"
for f in "$REPO/agents/"*.md; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  target="$CLAUDE/agents/$name"
  if [ -L "$target" ]; then
    echo "  ↺  agents/$name (already linked, updating)"
    ln -sf "$f" "$target"
  elif [ -f "$target" ]; then
    echo "  ⚠  agents/$name exists as a regular file — backing up to $target.bak"
    mv "$target" "$target.bak"
    ln -s "$f" "$target"
  else
    echo "  +  agents/$name"
    ln -s "$f" "$target"
  fi
done

# Skills
mkdir -p "$CLAUDE/skills"
for dir in "$REPO/skills/"*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  target="$CLAUDE/skills/$name"
  src="${dir%/}"
  if [ -L "$target" ]; then
    echo "  ↺  skills/$name (already linked, updating)"
    ln -sfn "$src" "$target"
  elif [ -d "$target" ]; then
    echo "  ⚠  skills/$name exists as a regular directory — backing up to $target.bak"
    mv "$target" "$target.bak"
    ln -s "$src" "$target"
  else
    echo "  +  skills/$name"
    ln -s "$src" "$target"
  fi
done

echo ""
echo "Done. Restart Claude Code to pick up the new agents and skills."
echo "Run './install.sh --check' any time to verify links are still healthy."
