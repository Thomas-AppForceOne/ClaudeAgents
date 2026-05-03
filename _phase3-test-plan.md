# Phase 3 — End-to-end test plan

Branch: `feature/stack-plugin-rfc` at commit `7b64bc5`. This plan covers the Phase 3 cutover (E1 + E2 + E3) only. Earlier phases (R-series, post-R audit) are assumed already verified.

Two plans, separated by who can run them:

- **Plan A — human-only.** Real machine, real Claude Code, real LLM-driven agent runs. Catches UX regressions and prompt-quality issues the harness can't see.
- **Plan B — Claude-executable.** Automated regression battery; can be run repeatedly. Includes a post-E1 audit pass that the roadmap requires before merge to `main`.

---

## Note on copy-pasting commands

Markdown tables require pipe characters inside cells to be escaped as `\|`. **When you copy a command into bash, drop the backslash before each `|`.** Example: a cell containing `cmd1 \| cmd2` should be run as `cmd1 | cmd2`. Single-quoted regexes inside `grep -rE '...'` need the same unescaping (the bar is alternation, not a pipe). If a command does not contain `\|`, no changes are needed.

---

# Plan A — Human dogfooding

## Pre-flight

| Step | Action                                                                                                              | Expected outcome                                                        | If it fails                           |
| ---- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------- |
| A0.1 | Pick a clean test directory: `mkdir ~/cas-phase3-test && cd ~/cas-phase3-test && git init && git checkout -b test`. | Empty git repo on a `test` branch.                                      | n/a                                   |
| A0.2 | From the framework checkout: `cd /Users/thak/projects/ClaudeAgents-stack-plugin-rfc && git status`.                 | `On branch feature/stack-plugin-rfc`, clean working tree, at `7b64bc5`. | If dirty, stop and assess.            |
| A0.3 | Confirm Claude Code version: `claude --version`.                                                                    | Whatever you have installed; record it for the test log.                | If absent, install Claude Code first. |

## A1 — Installer

| Step | Action                                                                         | Expected outcome                                                                                                                                                                                                                                     | If it fails                                                                 |
| ---- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A1.1 | `cd /Users/thak/projects/ClaudeAgents-stack-plugin-rfc && ./install.sh --help` | Help text prints; exit 0. Lists `--uninstall`, `--no-claude-code`, `--help`. No mention of maintainer-only scripts.                                                                                                                                  | Read help text; if it references maintainer scripts, F4 violation.          |
| A1.2 | `./install.sh` (a clean install).                                              | Script: prerequisite checks → symlinks `agents/*.md` and `skills/gan/` → installs the global package → MCP server registered in `~/.claude.json` → `~/.claude/gan/builtin-stacks/` symlink created → final "ClaudeAgents installed" message. Exit 0. | Read full output; identify the failing step.                                |
| A1.3 | `ls -la ~/.claude/gan/builtin-stacks/`                                         | Symlink resolves to `<package-root>/stacks/`; contains `web-node.md` and `generic.md`.                                                                                                                                                               | Per Sprint 7 of R-series — symlink missing means R2 install code regressed. |
| A1.4 | `grep -A 5 '"claudeagents-config"' ~/.claude.json`                             | The `claudeagents-config` MCP entry prints with the correct `command` field; `args: []`, `env: {}`.                                                                                                                                                  | If absent, the install's MCP-config-edit step failed.                       |
| A1.5 | `./install.sh` (re-run for idempotency).                                       | Reports "already installed (versions match)" or similar; no duplicate symlinks; no duplicate MCP entry. Exit 0.                                                                                                                                      | Idempotency regression.                                                     |

## A2 — Claude Code restart + MCP permission

| Step | Action                                                                | Expected outcome                                                                                                                                                                                                                                                                            | If it fails                                                                                |
| ---- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A2.1 | Quit Claude Code completely (Cmd+Q on macOS). Wait 3 seconds. Reopen. | Clean restart.                                                                                                                                                                                                                                                                              | n/a                                                                                        |
| A2.2 | Open a fresh chat in your test directory (`~/cas-phase3-test`).       | Empty chat.                                                                                                                                                                                                                                                                                 | n/a                                                                                        |
| A2.3 | Type `/gan --help` and submit.                                        | Claude Code's first invocation of the new MCP server triggers a permission prompt; approve it. After approval, the help text from SKILL.md prints. **No `validateAll()` is called** — no validation errors should fire on an empty repo.                                                    | If validation errors fire on `--help`, the help-short-circuit pre-validate gate is broken. |
| A2.4 | Read the help text carefully.                                         | Lists every top-level flag (`--help`, `--print-config`, `--recover`, `--list-recoverable`, `--no-project-commands`). Mentions the `gan` CLI for configuration and `.claude/gan/project.md` for overlays. **No** maintainer-only script names. **No** "the npm package" / "Node MCP server". | F4 prose discipline regression.                                                            |

## A3 — `--print-config` on an empty project

| Step | Action                                                                             | Expected outcome                                                                                                                                                                                                               | If it fails                                                                    |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| A3.1 | In a fresh chat in `~/cas-phase3-test`: `/gan --print-config`                      | Prints a resolved-config JSON or human-readable view. The active stack set should be `[generic]` (no recognized ecosystem; falls through to the conservative fallback). No worktree is created. No agents spawn. Exit cleanly. | If the active set is empty (`[]`) or includes `web-node`, detection is broken. |
| A3.2 | Verify the output mentions `generic` as the active stack and shows tier `builtin`. | Visible in the output.                                                                                                                                                                                                         | Detection regression.                                                          |

## A4 — First-run nudge

| Step | Action                                                                                                                             | Expected outcome                                                                                                                                                                                                                                                                                                                                 | If it fails                                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| A4.1 | In a fresh chat in `~/cas-phase3-test`: `/gan "make a tiny shell script that prints hello"`                                        | Per SKILL.md the orchestrator runs `validateAll()` → `getResolvedConfig()` → startup log. **The startup log MUST include the verbatim first-run nudge text** because the active stack set is `[generic]` only. Look for: "No recognised ecosystem stack — running with generic defaults. For richer behaviour, run \`gan stacks new <name>\`..." | If the nudge is missing, SKILL.md's nudge logic regressed.                            |
| A4.2 | Let the orchestrator continue: planner → contract-proposer → contract-reviewer → generator → evaluator. Watch each agent's output. | Each agent should produce sensible, snapshot-driven output. The proposer's contract criteria should NOT include hardcoded ecosystem-specific tokens — only generic surfaces from `stacks/generic.md`'s `securitySurfaces` (secrets_not_committed, untrusted_input_handling, error_message_hygiene, secure_defaults).                             | If criteria mention ecosystem-specific commands, the proposer prompt is regressed.    |
| A4.3 | Wait for the run to complete or fail at the evaluator. Capture the entire transcript.                                              | Run lands a generated shell script in the worktree.                                                                                                                                                                                                                                                                                              | Read the transcript; the first place any of the 5 agents misbehave is the regression. |

## A5 — Real web-node run

| Step | Action                                                                                                                                | Expected outcome                                                                                                                                                                                                                                                                                                                                                          | If it fails                                                                                                                           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A5.1 | New project: `mkdir ~/cas-phase3-webnode && cd ~/cas-phase3-webnode && git init && npm init -y && npm install --save-dev typescript`. | A package manifest plus a lockfile exist. Composite-detection composite is satisfied (lockfile present).                                                                                                                                                                                                                                                                  | n/a                                                                                                                                   |
| A5.2 | In a fresh Claude Code chat in `~/cas-phase3-webnode`: `/gan "build a simple Express HTTP server"`                                    | Startup log shows `web-node` as active (NOT `[generic]`). **No first-run nudge** (web-node is not the generic fallback). The proposer's contract should now include web-node-specific criteria from `stacks/web-node.md`'s `securitySurfaces` — TLS, CORS, session cookies, HTTP route validation, shell safety, prototype pollution, JS-flavoured secrets-not-committed. | If active set is `[generic]` or `[]`, web-node detection regressed. If criteria are stack-agnostic, template instantiation regressed. |
| A5.3 | Watch the generator produce code. Watch the evaluator score against criteria.                                                         | Generator writes Express code. Evaluator runs the test/lint/audit commands sourced from the snapshot's web-node stack.                                                                                                                                                                                                                                                    | If evaluator runs hardcoded commands instead of snapshot-sourced commands, regression.                                                |

## A6 — `gan` CLI surface

| Step | Action                                                     | Expected outcome                                                                                                                             | If it fails                 |
| ---- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| A6.1 | `gan --help` (in any directory).                           | CLI help prints. Lists `validate`, `stacks new\|customize\|reset\|list\|available\|where`, `trust *`, `config set\|get`, `migrate-overlays`. | R3 regression.              |
| A6.2 | `gan stacks available` (anywhere).                         | Lists `web-node` and `generic` (the two shipped built-in stacks).                                                                            | E2 regression.              |
| A6.3 | `cd ~/cas-phase3-webnode && gan stacks where web-node`.    | Resolves to the built-in tier (`<package-root>/stacks/web-node.md`).                                                                         | C5 resolution regression.   |
| A6.4 | `gan stacks customize web-node` in `~/cas-phase3-webnode`. | Copies `web-node.md` to `.claude/gan/stacks/web-node.md`. Verify the file appeared.                                                          | R3 sprint 6 regression.     |
| A6.5 | `gan stacks where web-node` again.                         | Now resolves to the project tier.                                                                                                            | Tier-precedence regression. |
| A6.6 | `gan stacks reset web-node` in `~/cas-phase3-webnode`.     | Removes the project-tier copy.                                                                                                               | R3 regression.              |
| A6.7 | `gan validate` in `~/cas-phase3-webnode`.                  | Either reports "config is valid" or surfaces structured errors with `code` / `file` / `field` / `message`.                                   | F2 contract regression.     |

## A7 — Uninstall

| Step | Action                                                                               | Expected outcome                                                                                                                                                                                                                                                     | If it fails                                                |
| ---- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A7.1 | `cd /Users/thak/projects/ClaudeAgents-stack-plugin-rfc && ./install.sh --uninstall`. | Removes the agent / skill symlinks; removes the `claudeagents-config` MCP entry from `~/.claude.json`; removes `~/.claude/gan/builtin-stacks/` symlink (since it points into the framework install). Leaves `.gan-state/` and `.gan-cache/` in user projects intact. | Read script output; identify failing branch.               |
| A7.2 | Restart Claude Code. `/gan` in any chat.                                             | Should report "ClaudeAgents not installed" or similar — slash command should not function.                                                                                                                                                                           | If `/gan` still works, uninstall didn't clean up properly. |
| A7.3 | Re-install via `./install.sh` to restore for normal use.                             | Clean install.                                                                                                                                                                                                                                                       | n/a                                                        |

## A8 — UX-quality judgment calls (no objective expected outcome)

For each of the steps above, ask yourself:

- Did the prose feel friendly to a developer who isn't a Node person? (F4's iOS-developer-on-macOS test.)
- Did any error message point you toward an ecosystem-specific command instead of a shell command? (F4 violation.)
- Did the agent prompts produce output that felt like the legacy prompts plus structured config — or did the rewrite drop something load-bearing?
- Was the first-run nudge actionable, or just noise?
- Did `/gan` finish cleanly, or did the harness leave the worktree in a half-state?

Capture these as a free-form "UX notes" file — this is the input the test harness can't generate.

---

# Plan B — Claude-executable battery

Tell Claude to run any of these. Each subsection is independently runnable.

## B1 — Build + standing checks (regression baseline)

| Step | Command                                                               | Expected                           |
| ---- | --------------------------------------------------------------------- | ---------------------------------- |
| B1.1 | `cd /Users/thak/projects/ClaudeAgents-stack-plugin-rfc && git status` | Clean working tree at `7b64bc5`.   |
| B1.2 | `npm run build`                                                       | Exit 0. Builds `dist/` clean.      |
| B1.3 | `npx tsc --noEmit`                                                    | Exit 0.                            |
| B1.4 | `npm run lint`                                                        | Exit 0.                            |
| B1.5 | `npm run format:check`                                                | Exit 0.                            |
| B1.6 | `npm test`                                                            | Exit 0; 671 tests across 80 files. |

## B2 — All maintainer lints

| Step | Command                                                                                                             | Expected                                |
| ---- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| B2.1 | `npm run lint-stacks`                                                                                               | "2 stacks checked, 0 failed".           |
| B2.2 | `npm run lint-no-stack-leak`                                                                                        | "42 files scanned, 0 hits".             |
| B2.3 | `npm run lint-error-text`                                                                                           | "67 files scanned, 0 hits".             |
| B2.4 | `npm run evaluator-pipeline-check`                                                                                  | "5 fixtures checked, 0 failed". Exit 0. |
| B2.5 | `node dist/scripts/evaluator-pipeline-check/index.js --update-goldens && git diff --quiet -- tests/fixtures/stacks` | Exit 0 (idempotency).                   |

## B3 — Retirement table closure audit

Cross-check every row of the retirement table in `roadmap.md` lines 169–183 against the actual repo state.

| Step | Command                                                                                                                                                               | Expected                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| B3.1 | `find . -path '*/skills/gan/gan' -o -path '*/skills/gan/schemas/*'`                                                                                                   | Empty.                               |
| B3.2 | `git log --oneline --diff-filter=D -- skills/gan/schemas/ skills/gan/gan`                                                                                             | Shows the Sprint 6 deletion commits. |
| B3.3 | For each `M` row: `git log --since="$(git log --reverse --format=%H feature/stack-plugin-rfc \| head -1)" --oneline -- agents/gan-*.md skills/gan/SKILL.md README.md` | Shows the Phase 3 rewrites.          |
| B3.4 | `grep -rE 'skills/gan/schemas/(contract\|feedback\|objection\|progress\|review\|telemetry-summary)\.schema\.json' .`                                                  | Empty.                               |
| B3.5 | `grep -rE '\.gan/(progress\|sprint-\|spec\|contract\|feedback)' src/ scripts/ agents/ skills/`                                                                        | Empty.                               |

## B4 — Stack-leak deep audit (beyond `lint-no-stack-leak`)

| Step | Command                                                                                                                                           | Expected                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| B4.1 | `grep -nrEi '\b(npm audit\|pip-audit\|cargo audit\|govulncheck\|bundle audit\|gradle\|kotlin\|kts\|mvn)\b' agents/ skills/gan/SKILL.md README.md` | Empty (or only inside explicitly-allowlisted contexts that the lint already approves). |
| B4.2 | `grep -nrE 'package\.json\|node_modules' src/agents/evaluator-core/`                                                                              | Empty (the carve-out is pure; ecosystem-agnostic).                                     |
| B4.3 | `grep -nrE '"the npm"\|"npm package"\|"Node MCP server"' agents/ skills/ README.md`                                                               | Empty.                                                                                 |

## B5 — Spec-vs-code drift audit (post-E1 audit prerequisites)

This is the audit work the post-E1 revision break asks for. Per the roadmap, three specs need verifying against E1's implementation:

| Step | Action                                                                                                                                                                                    | What to look for                                                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| B5.1 | Read `specifications/O1-resolution-observability.md` and grep for the startup-log shape it describes. Compare to what `skills/gan/SKILL.md` actually emits.                               | Does the documented log line match what the new SKILL.md says it emits? Drift = O1 needs revision.                                       |
| B5.2 | Read `specifications/U3-additional-context-splice.md` and confirm `agents/gan-planner.md` and `agents/gan-contract-proposer.md` consume `additionalContext` per the U3-described pattern. | Look at the Sprint 4 planner rewrite's "Context warnings" section. Does it match U3's `{path, exists}` model? Drift = U3 needs revision. |
| B5.3 | Read `specifications/O2-recovery.md` and confirm it's still marked "descriptive of intent only and **must not be implemented**".                                                          | Confirm the warning is intact. O2 must be authored prescriptively before the merge gate opens.                                           |

Compile findings into a draft "post-E1 audit notes" document for review.

## B6 — Branch-strategy audit

| Step | Command                                                                                                                                    | Expected                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| B6.1 | `git log --oneline main..feature/stack-plugin-rfc`                                                                                         | Shows the full branch history (all R-series + audit + Phase 3 sprints). |
| B6.2 | `git log --oneline feature/stack-plugin-rfc -- agents/ skills/ stacks/ src/agents/ src/config-server/ src/cli/ scripts/ tests/ install.sh` | Shows the implementation commits. No drift outside scope.               |
| B6.3 | `git diff main..feature/stack-plugin-rfc --stat \| tail -5`                                                                                | Shows total file count. Sanity-check no surprise massive change.        |

## B7 — Sanity checks the Phase 3 sprints didn't run individually

| Step | Command                                                                                                  | Expected                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| B7.1 | `find tests/fixtures/stacks -name 'sprint-plan.json' \| wc -l`                                           | 5 (one per fixture).                                                         |
| B7.2 | `find tests/fixtures/stacks -name 'expected-evaluator-plan.json' \| wc -l`                               | 5.                                                                           |
| B7.3 | `cat scripts/lint-no-stack-leak/allowlist.json \| python3 -m json.tool`                                  | `transitional` is empty `{}`. (Sprints 3 + 4 emptied it.)                    |
| B7.4 | `wc -l agents/*.md skills/gan/SKILL.md`                                                                  | All under ~200 lines. (Legacy files were 95–557 lines; rewrites are 93–184.) |
| B7.5 | Run `node dist/scripts/evaluator-pipeline-check/index.js --json` and verify the output is parseable JSON | Exit 0; valid JSON.                                                          |

## B8 — Spec internal consistency

| Step | Action                                                                                                                                                                 | What to look for                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| B8.1 | Verify the per-token rows in the audit-notes content (now in Sprint 6's commit message) all resolve to actual surfaces in `stacks/web-node.md` or `stacks/generic.md`. | For each "lifted-into-web-node" entry, the surface ID should exist in the file. |
| B8.2 | Verify `roadmap.md` retirement-table mechanism (`M` vs `D`) matches what's actually in the diff.                                                                       | All 8 deletions are `D`, all 6 rewrites are `M`.                                |

---

# Suggested execution order

1. **First:** Run Plan B (Claude-executable). If anything red, fix before dogfooding.
2. **Then:** Run Plan A start to finish. Capture UX notes alongside the objective outcomes.
3. **If both pass:** the post-E1 revision break can open. The audit findings from B5 feed directly into that revision break, plus O2 prescriptive authoring is the substantive new design work.
4. **Only after the post-E1 break closes:** merge `feature/stack-plugin-rfc` to `main`.

---

_File location: `_phase3-test-plan.md` at the repo root, following the underscore-prefix convention used by `specifications/_audit-post-r.md` for working drafts. Move or rename as you prefer._
