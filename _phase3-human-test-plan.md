# Phase 3 — Human-only test plan (Plan C)

Plan A's executable subset and Plan B already passed (committed at `b8fae00` and earlier). This plan covers the remaining 30% that requires real Claude Code, real LLM-driven agent runs, and human UX judgment.

## Pre-conditions (verified at commit `2c1b8da`)

- Framework installed from `feature/stack-plugin-rfc` (`./install.sh` succeeded; `~/.claude.json` has the `claudeagents-config` MCP entry; `~/.claude/gan/builtin-stacks/` symlinks back to the repo).
- Three test projects already on disk from Plan A's runs (Claude could not clean these up):
  - `~/cas-phase3-test/` — empty git repo, no recognized ecosystem.
  - `~/cas-phase3-webnode/` — has `package.json` + `package-lock.json` + `start`/`dev`/`build` scripts → web-node activates.
  - `~/cas-phase3-bare-pkg/` — has `package.json` only (no lockfile, no scripts) → falls through to generic.
- Branch HEAD: `2c1b8da`. The installer printed a "you are installing from the `feature/stack-plugin-rfc` branch ... not functional end-to-end yet" warning. **Mid-pivot caveat applies.** Some downstream agent steps may not complete.

## What to capture as you go

For each step: paste the actual output (or transcript-relevant excerpts), plus a one-line verdict (PASS / FAIL / PARTIAL). Note any UX surprises in your head; collect them under C7 at the end.

---

## C1 — Claude Code restart

|                 |                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **Action**      | Quit Claude Code completely (Cmd+Q on macOS). Wait 3 seconds. Reopen.                             |
| **Expected**    | Clean restart. The new MCP server registration and rewritten skill files load on next invocation. |
| **Capture**     | Confirm "yes, restarted" in your notes.                                                           |
| **If it fails** | Check that Claude Code closed fully (Activity Monitor); some skills cache aggressively.           |

---

## C2 — `/gan --help` short-circuit

|                     |                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Action**          | In a fresh chat (any directory): type `/gan --help`. Submit.                                                                                                                                                                                                                                                                                                                                |
| **Expected**        | Help text prints. The text comes from `skills/gan/SKILL.md`. **No MCP server permission prompt** (the `--help` flag short-circuits before `validateAll()`). **No validation errors**. The text lists `--help`, `--print-config`, `--recover`, `--list-recoverable`, `--no-project-commands`. References "the framework" or "ClaudeAgents" — **not** "the npm package" or "Node MCP server". |
| **Capture**         | The full text Claude Code prints.                                                                                                                                                                                                                                                                                                                                                           |
| **PASS criteria**   | Help text appears; no validation errors; no maintainer-script names in the prose.                                                                                                                                                                                                                                                                                                           |
| **FAIL indicators** | A validation error fires before the help text → SKILL.md's pre-validation short-circuit is broken. F4 vocabulary leaked → prose discipline regression.                                                                                                                                                                                                                                      |

---

## C3 — `/gan --print-config` against an empty project (first MCP call)

|                     |                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Action**          | In Claude Code, change directory to `~/cas-phase3-test/` (use `cd` in your shell first, then open Claude Code there, OR use Claude Code's directory selector). In a fresh chat: type `/gan --print-config`.                                                                                                                                                          |
| **Expected**        | **First-time MCP permission prompt** for `claudeagents-config` — approve it. After approval, the resolved config prints. The active stack set is `[generic]`. The tier is `builtin`. The stack path resolves to (something like) `/Users/thak/projects/ClaudeAgents-stack-plugin-rfc/stacks/generic.md`. No worktree is created. The chat does not spawn sub-agents. |
| **Capture**         | The output (resolved-config block). Confirm `tier: builtin` (not the retired `repo`).                                                                                                                                                                                                                                                                                |
| **PASS criteria**   | Approval prompt fires once; output matches the JSON I already verified via `gan config print`.                                                                                                                                                                                                                                                                       |
| **FAIL indicators** | No prompt and no output → MCP server didn't start (check the `command` is on PATH from Claude Code's perspective). Output uses `tier: repo` → post-R audit didn't propagate.                                                                                                                                                                                         |

---

## C4 — First-run nudge in a real LLM-driven sprint

This is **the** test for E1's first-run nudge contract. Plan B verified the deterministic half (SKILL.md contains the verbatim string). This verifies that an actual LLM running SKILL.md actually emits it.

|                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Action**                       | In Claude Code in `~/cas-phase3-test/` (the empty project), in a fresh chat: type `/gan "make a tiny shell script that prints hello"` and submit.                                                                                                                                                                                                                                                                                                |
| **Expected — startup log**       | Per SKILL.md the orchestrator runs `validateAll()` → `getResolvedConfig()` → prints a startup log line summarizing active stacks, overlays, additionalContext. Because the active stack set is `[generic]` only, the startup log **must include the verbatim first-run nudge** beginning with: `No recognised ecosystem stack — running with generic defaults. For richer behaviour, run \`gan stacks new <name>\` to scaffold a stack file...`. |
| **Expected — sprint loop**       | The orchestrator creates `.gan-state/runs/<run-id>/worktree/` and starts the sprint loop. Per the installer's mid-pivot warning, the run **may not complete end-to-end** — but it should at least: start the planner, produce a spec, propose a contract, attempt a generation, attempt an evaluation. Watch for graceful failure if it stops.                                                                                                   |
| **Expected — proposer behavior** | The proposed contract's security criteria source from `stacks/generic.md`'s `securitySurfaces` (`secrets_not_committed`, `untrusted_input_handling`, `error_message_hygiene`, `secure_defaults`). **No hardcoded ecosystem-specific tokens** (`npm audit`, `pip-audit`, etc.) — those are retired per E1.                                                                                                                                        |
| **Capture**                      | The full transcript: startup log line, planner's spec output, proposer's contract output, any subsequent agent output. Save to a file (e.g. `~/cas-phase3-c4-transcript.txt`) to share with me. Mark with timestamps if Claude Code's UI shows them.                                                                                                                                                                                             |
| **PASS criteria**                | First-run nudge text visibly appears in the startup log. Proposer's criteria are stack-agnostic. Worktree is created at `.gan-state/runs/<run-id>/worktree/` (verify via `ls ~/cas-phase3-test/.gan-state/runs/`).                                                                                                                                                                                                                               |
| **FAIL indicators**              | Nudge text missing → SKILL.md's nudge-emission instruction wasn't followed by the LLM. Hardcoded `npm audit` / `pip-audit` in proposer output → hardcoded checklist regression. Worktree at the legacy `.gan/worktree/` path → F1 zone-2 cutover incomplete.                                                                                                                                                                                     |
| **Mid-pivot tolerance**          | If the run aborts at sprint generation or evaluation: capture WHERE it aborted and WHY. That's still informative — we want the early phases (validation, snapshot, planner, proposer) to be rock-solid even if the late phases (full generator/evaluator loop) hit an unrelated bug.                                                                                                                                                             |

---

## C5 — Real web-node sprint loop

This validates that web-node detection + securitySurfaces + per-stack tooling all flow end-to-end through a real LLM-driven run.

|                                   |                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Action**                        | In Claude Code in `~/cas-phase3-webnode/` (the project with `package.json` + lockfile), fresh chat: type `/gan "build a simple Express HTTP server with /healthz and /version endpoints"`.                                                                                                                                                                                                                            |
| **Expected — startup log**        | Active stack set is `[web-node]` only (NOT `[generic]`). **No** first-run nudge. Tier `builtin`.                                                                                                                                                                                                                                                                                                                      |
| **Expected — proposer behavior**  | The proposed contract's security criteria include items derived from `stacks/web-node.md`'s `securitySurfaces`: TLS-required, CORS-not-wide-open, session-cookie-flags, HTTP-route-input-validation, shell-and-subprocess-safety, prototype-pollution, secrets-not-committed (JS-flavoured). **Each criterion's rationale should trace back to a surface** (e.g. "from web-node.tls_required_for_sensitive_traffic"). |
| **Expected — generator behavior** | If the generator runs: it writes Express code in the worktree. After write, it should attempt a verification build via `snapshot.activeStacks[*].buildCmd` (which for web-node is `npm run build`). The graceful-fallback wording from the Sprint 4 rewrite means absence of buildCmd produces a graceful skip rather than a crash.                                                                                   |
| **Expected — evaluator behavior** | If the evaluator runs: it sources `secretsGlob` (js, ts, json, env), `auditCmd` (`npm audit --audit-level=high`), `testCmd` / `lintCmd` from `snapshot.activeStacks[*]`. The deterministic core's evaluator-plan describes which surfaces fire on which files.                                                                                                                                                        |
| **Capture**                       | Save transcript to `~/cas-phase3-c5-transcript.txt`. Note in particular: the proposer's criteria list (paste it verbatim), the generator's verification-build attempt (or its skip), the evaluator's evaluator-plan if visible.                                                                                                                                                                                       |
| **PASS criteria**                 | Active set is `[web-node]`. Proposer criteria trace to web-node surfaces. Generator and evaluator (if they run) source per-stack commands from the snapshot.                                                                                                                                                                                                                                                          |
| **FAIL indicators**               | Active set wrong → composite-detection regression. Criteria mention non-web-node ecosystems (Python, Rust, Go) → hardcoded checklist regression in proposer. Evaluator runs `pip-audit` or similar → hardcoded ecosystem tokens leaked back.                                                                                                                                                                          |
| **Mid-pivot tolerance**           | Same as C4 — capture failure point if the run aborts; the earlier phases are the primary targets.                                                                                                                                                                                                                                                                                                                     |

---

## C6 — Uninstall + reinstall

|                     |                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Action 6.1**      | In your shell (not Claude Code): `cd /Users/thak/projects/ClaudeAgents-stack-plugin-rfc && ./install.sh --uninstall`.                                                                                                                                                                                                                 |
| **Expected**        | Removes agent and skill symlinks; removes the `claudeagents-config` MCP entry from `~/.claude.json`; removes the `~/.claude/gan/builtin-stacks/` symlink (since it points into the framework install). Leaves `~/cas-phase3-test/.gan-state/` and `~/cas-phase3-webnode/.gan-state/` (if present from the C4/C5 runs) intact. Exit 0. |
| **Capture**         | Final stdout block.                                                                                                                                                                                                                                                                                                                   |
| **Action 6.2**      | Restart Claude Code. In a fresh chat: type `/gan --help`.                                                                                                                                                                                                                                                                             |
| **Expected**        | The `/gan` slash command should report "skill not found" or similar — the framework has been uninstalled. **No** help text from SKILL.md.                                                                                                                                                                                             |
| **Capture**         | What Claude Code says.                                                                                                                                                                                                                                                                                                                |
| **Action 6.3**      | In your shell: `./install.sh` (re-install fresh).                                                                                                                                                                                                                                                                                     |
| **Expected**        | Same as A1.2 in the original Plan A — install completes; restart Claude Code; `/gan` works again.                                                                                                                                                                                                                                     |
| **Capture**         | Confirm `/gan --help` works again after the second restart.                                                                                                                                                                                                                                                                           |
| **PASS criteria**   | Uninstall removes the framework cleanly; `/gan` becomes unavailable; reinstall restores it.                                                                                                                                                                                                                                           |
| **FAIL indicators** | After uninstall, `/gan` still functions → uninstall didn't clean MCP config or symlinks. After reinstall, `/gan` doesn't function → install regression.                                                                                                                                                                               |

---

## C7 — UX judgment notes (free-form)

Open a notes file (`~/cas-phase3-ux-notes.md` or similar). For each of the steps above, note:

- **Friction.** Anything that felt clunky, unclear, or surprising.
- **Prose discipline.** Did any agent's user-facing output mention "the npm package" / "Node MCP server" / specific maintainer-only scripts (`lint-stacks`, `publish-schemas`, `evaluator-pipeline-check`)? Any error message that pointed at `npm run X` instead of a shell command?
- **First-run-friendliness.** A non-Node developer (per F4's iOS-developer-on-macOS test) — would they be able to follow what's happening?
- **Honesty signals.** The installer's mid-pivot warning was a positive signal. Did anything else surface honest about its state (good) or hide problems (bad)?
- **Surprises.** Anything that worked unexpectedly well, or unexpectedly poorly.

This is the input the harness can't generate.

---

## Reporting back

When you're done, paste back:

1. A PASS/FAIL/PARTIAL for each of C1–C6.
2. The transcript files from C4 and C5 (or relevant excerpts).
3. The UX notes from C7.
4. Sign-off on the 6 O2 decisions in `specifications/O2-recovery.md.proposed`.

I'll then:

- Roll any new findings (C-prefix) into a post-E1 audit reconciliation commit, alongside the existing Findings 3 & 4 from Plan A.
- Replace `O2-recovery.md` with the prescriptive version using your decisions.
- That closes the post-E1 revision break and opens the merge gate to `main`.

---

_File location: `_phase3-human-test-plan.md` at the repo root, paired with `_phase3-test-plan.md` (the original Claude+human plan). Same underscore-prefix convention. Move or rename as you prefer._
