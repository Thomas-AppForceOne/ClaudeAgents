#!/bin/bash
# Install GAN agents and skills into ~/.claude/
# Creates symlinks so edits in this repo are reflected immediately.

set -e

REPO="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$HOME/.claude"

echo "Installing from: $REPO"
echo "Installing into: $CLAUDE"
echo ""

# Agents
mkdir -p "$CLAUDE/agents"
for f in "$REPO/agents/"*.md; do
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
  name="$(basename "$dir")"
  target="$CLAUDE/skills/$name"
  if [ -L "$target" ]; then
    echo "  ↺  skills/$name (already linked, updating)"
    ln -sf "$dir" "$target"
  elif [ -d "$target" ]; then
    echo "  ⚠  skills/$name exists as a regular directory — backing up to $target.bak"
    mv "$target" "$target.bak"
    ln -s "$dir" "$target"
  else
    echo "  +  skills/$name"
    ln -s "$dir" "$target"
  fi
done

echo ""
echo "Done. Restart Claude Code to pick up the new agents and skills."
