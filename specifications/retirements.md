# ClaudeAgents — Retirements

Closed historical record of every old artifact retired during the redesign. Each row names the artifact, the spec whose implementation retired it, and the retirement mechanism. All rows below are completed; the corresponding specs have shipped and the artifacts are gone from the working tree.

This file is appended to whenever a future spec retires additional artifacts. The pattern carries forward from v1.0+: implementation PRs that retire artifacts must delete them in the same PR, and the row lands here at merge time.

Two retirement mechanisms appear:

- **`M` (rewrite in place):** the file survives at the same path; its contents are fully replaced. The implementation PR's diff shows a `M` entry, with most or all of the file's content changed. Old behavior at that path is gone after the PR lands.
- **`D` (delete):** the file is removed entirely. The implementation PR's diff shows a `D` entry. Whatever the old file did has either moved to a different path (with attribution) or been retired without replacement.

## Retirement table

| Old artifact | Retired by | Mechanism |
|---|---|---|
| `agents/gan-planner.md` | E1 | `M` — rewritten in place. New content consumes `getResolvedConfig()` instead of reading `.gan/` files. |
| `agents/gan-contract-proposer.md` | E1 | `M` — rewritten in place. Hardcoded checklist content lifts to stack-file `securitySurfaces` per E2; nothing remains in the prompt. |
| `agents/gan-contract-reviewer.md` | E1 | `M` — rewritten in place. New content consumes the snapshot; old `.gan/` reads removed. |
| `agents/gan-generator.md` | E1 | `M` — rewritten in place. |
| `agents/gan-evaluator.md` | E1 | `M` — rewritten in place. The hardcoded stack-specific tokens are processed per E2's extraction audit: tokens belonging to a shipped stack (`npm audit`, web/Node security surfaces) move into `stacks/web-node.md`; tokens belonging to off-plan ecosystems (`kt`, `kts`, `gradle`, `pip-audit`, `cargo audit`, `govulncheck`, `bundle audit`, etc.) are either retained as synthetic-second fixture content or explicitly retired-not-lifted in E2's PR audit. The rewritten prompt contains zero stack-specific tokens, verified by R4's `lint-no-stack-leak`. |
| `skills/gan/SKILL.md` | E1 | `M` — rewritten in place. The 557-line existing file's flow (Step 0 / 0.5 / 0.75 / 1 / 2a / 2b / 3) is replaced wholesale; the new orchestrator calls `validateAll()` first, captures the snapshot once, and consumes the API. Not a refactor — full content replacement. |
| `skills/gan/gan` | E1 | `D` — broken symlink; dead artifact. |
| `skills/gan/schemas/{contract,feedback,objection,progress,review,telemetry-summary}.schema.json` | E1 | `D` — these run-state schemas describe per-run state inside the old orchestrator. The rewritten orchestrator either re-authors them under a new location consistent with F1's zones (e.g. `schemas/run-state/<type>-v1.json` per F3's naming) **or** drops them if the new flow no longer validates against the same shapes. Either path requires deleting the originals: leaving them at the old path implies the old SKILL.md is still loading them. The E1 PR must commit to one of the two paths and execute it. |
| `install.sh` (existing 138-line `.gan/`-based installer) | R2 | `M` — rewritten in place. Same path, full content replacement implementing R2's spec. No transition period. |
| `.gan/` directory contract (in code) | F1 + E1 | F1 specifies the new zones (the contract). E1's PR removes every code reference to `.gan/` from the rewritten orchestrator and prompts. User-side `.gan/` state in user repos is documented in R2's installer (and release notes) as "delete by hand; start fresh" — pre-1.0 + no-backward-compat. |
| Hardcoded stack-specific knowledge inside agent prompts | E1 + E2 | E1's rewrite physically removes the tokens from the prompts. E2 verifies at extraction time that every stack-specific concept has a home in `stacks/<name>.md` — anything dropped is explicitly listed as "retired, not lifted" in the E2 PR's body. R4's `lint-no-stack-leak` is the permanent backstop scanning agent prompts and core code for ecosystem tokens outside their owning stack files. |
| `README.md` (existing 214-line description of the old `.gan/`-based architecture) | E1 | `M` — rewritten in place. The README is the most user-visible piece of legacy in the working tree (`git clone`'s first impression); after E1 the framework operates fundamentally differently and the README must reflect that. Same E1 PR that lands the orchestrator rewrite. |
| `.gitignore` at repo root (currently lists only `.DS_Store` and review correspondence) | F1 | `M` — F1's first implementation sprint adds `.gan-state/` and `.gan-cache/` entries so the new zones are gitignored from the moment they exist. Without this, a developer's first `/gan` run on the new architecture commits zone-2 run state into git. |

**Note on the run-state schema decision.** Six rows above (`skills/gan/schemas/{contract,feedback,objection,progress,review,telemetry-summary}.schema.json`) deferred the rewrite-or-drop choice to the E1 PR. Whichever path was chosen — re-author at `schemas/run-state/<type>-v1.json` per F3, or drop entirely — the row reads as a finished decision rather than a TODO at the time of merge.

**Verification.** When a named spec lands, the PR's reviewer checks the diff against the corresponding rows. Any survival is grounds for blocking the merge until the retirement is complete. After the spec lands, a periodic audit (`grep -r 'gan-evaluator\|gan-planner\|...' .` for the old-artifact names; the survival of the symlink as a broken pointer; etc.) catches anything that crept back. Dead-code rot is the failure mode this discipline closes.
