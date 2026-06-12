# Structural audit — 2026-06-12 (develop @ 68c4cb5)

Evidence-based health audit of the framework, triggered by `/gan` failing on the first sprint not passing review. This document records the findings, the root-cause analysis, and the fix plan. The fixes themselves are specified in eight phase-coded specs authored alongside this document (H4, E10, E11, F9, O4, Q8, D3) plus the in-flight E9 branch; this document is the cross-reference layer between findings and specs.

Companion docs: the verified bug-report corpus ([bugreports/](bugreports/)) and its [FIX-ORDER-PLAN.md](bugreports/FIX-ORDER-PLAN.md) (2026-06-08). This audit confirms that plan's clustering and extends it with findings the BR corpus did not capture (the confinement-hook allowlist gap, the unwired first-pass contract review, the lock lifecycle, the tool-grant mismatches).

## Root cause of the first-sprint review failure

**Primary: the confinement-hook artifact allowlist was never updated for the E8/E5 artifact set.** `scripts/hooks/gan-confine.sh.template:245-256` allows only the pre-E8 artifacts (`progress.json`, `sprint-*-contract.json`, `sprint-*-contract-draft.json`, `sprint-*-feedback-*.json`, `sprint-*-objection-*.json`, `sprint-*-base-commit.txt`, `trace/*`, `telemetry/*`). Everything the clarification and review stages must write is **denied** (verified by live probe against the installed hook, 2026-06-12):

| Artifact | Mandated by | Hook verdict |
|---|---|---|
| `sprint-1-independent-review-A.json` | SKILL.md:470, gan-reviewer-independent.md | **deny** |
| `sprint-1-review.json` (contract-reviewer verdict) | gan-contract-reviewer.md | **deny** |
| `clarified-spec.md`, `raw-prompt.md` | SKILL.md:306,415 | **deny** |
| `spec.md`, `plan.md` | gan-planner.md | **deny** |
| `sprint-1-contract.draft-tmp.<token>.json` | SKILL.md:486 (relock input) | **deny** |
| `sprint-1-feedback-A.json`, `sprint-1-contract.json`, `progress.json` | — | allow |

Reproduction:

```bash
export GAN_RUN_ID=20260101T000000-abcd GAN_WORKTREE=/tmp/wt GAN_RUN_DIR=/tmp/rd
printf '{"tool_input":{"file_path":"/tmp/rd/sprint-1-independent-review-A.json"}}' \
  | bash ~/.claude/hooks/gan-confine.sh; echo $?   # → 1 (denied)
```

**Secondary: the first-pass contract review is unwired.** SKILL.md's sprint loop (step 10, lines 312–316) spawns planner → proposer → generator → evaluator and never spawns the contract-reviewer on the initial draft; nothing names or consumes its verdict file (`gan-contract-reviewer.md` says it writes `sprint-{N}-review.json`; SKILL.md never reads it). The contract-reviewer appears only inside the renegotiation loop (SKILL.md:472). Real runs improvised three different verdict filenames (`~/.gan-runs-data` corpus, BR-004/BR-006).

**Tertiary: negotiation ping-pong exhausts the seed ceilings.** Run `…b030`'s `telemetry/outcome.json` shows sprint 1 at `gan-contract-proposer: 3, gan-contract-reviewer: 3` — the proposer's seed ceiling (SKILL.md:358) — so one more `revise` halts the sprint as `LoopDetected`, surfaced to the user as "first sprint not passing review". E9's stricter reviewer (blocker on unresolved script names) raises the revise rate, making this *more* likely after the tier-5 branch lands unless the accounting changes (E10).

**Compounding:** the evaluator's blocker-auto-fail (gan-evaluator.md:121–123) combined with framework-self-inflicted blockers — the proposer's frontmatter omits access to the MCP pre-flight its own prompt mandates (E11), and `stacks/web-node.md:35` declares `lintCmd: vitest run` so lint findings are test findings (E11).

The two crashed 2026-06-09 runs (`…5e7d`, `…1bdd`) were themselves building the tier-5 fix branch; the hook gap is what killed them (no `progress.json`, no review artifacts, no proposer/reviewer trace events).

## Findings register

Severity: **C** critical / **M** major / **m** minor. Each row names the owning fix.

| # | Sev | Finding (evidence) | Fix |
|---|---|---|---|
| 1 | C | Hook allowlist missing every E5/E8-era artifact (`scripts/hooks/gan-confine.sh.template:245-256`; live probe above) | **H4** |
| 2 | C | First-pass contract-review verdict has no consumer; no canonical filename (SKILL.md:312-316 vs gan-contract-reviewer.md) | **E10** |
| 3 | C | No write-time schema enforcement on run-dir artifacts; malformed sprint-1 bundles completed `terminalReason: "success"` (BR-002:73, BR-003:65, BR-016:64, BR-001, BR-005) | **F9** |
| 4 | C | Run lock: live-pid holder blocks forever; `StrandedSelfLock` escape is manual `rm` (`src/config-server/storage/run-lock.ts:172-271`, SKILL.md:155,303) | **O4** |
| 5 | M | `buildEvaluatorPlan` caller ambiguity: SKILL.md:463 says orchestrator, gan-evaluator.md:24 says evaluator MUST call it; evaluator frontmatter cannot grant it | **E11** |
| 6 | M | Confinement narrower than prose claims: matcher `Write\|Edit\|MultiEdit\|NotebookEdit` only (install.sh:879); Bash side-effects unconfined while gan-evaluator.md:3 claims Bash runs under the hook | **H4** (prose), A2 (real Bash confinement, v1.1) |
| 7 | M | Proposer↔reviewer rounds burn per-role ceiling 3 inside sprint 1 (run `…b030` outcome.json) | **E10** |
| 8 | M | Blocker auto-fail + self-inflicted blockers (proposer frontmatter, gan-generator.md:56 false grant claim; `stacks/web-node.md:35` `lintCmd: vitest run`) | **E11** |
| 9 | M | Enforced constants duplicated in prose: ceilings/budget formula in SKILL.md:340,358,368 and `src/safety/loop-detection.ts:54-57`, `src/safety/config.ts:61,279` | **D3** |
| 10 | M | `progress.json` recovery guards documented but `[deferred-to-v1.1]` (SKILL.md:165,169,174); two real runs had no progress.json at all | **O4** + **F9** |
| 11 | M | Store-root marker read errors silently fall back to a fresh empty store; repo-key derivation drift orphaned pre-Jun-1 runs (`store-common.ts:75-83`, `run-store.ts:70-79`; `~/.gan-runs-data` has two keys for this repo) | **O4** |
| 12 | M | Safety-class trace-emit drops are telemetry-only; dropped `agentAttempt` events silently raise the thrash ceiling (`src/trace/append.ts:154-197`) | **O4** |
| 13 | M | Gate-strengthening PRs self-certify; no deterministic prompt-surface parity gates (BR-010) | **Q8** |
| 14 | M | Docs drift: PROJECT_CONTEXT.md:69 lists 5 of 7 agents; system-overview/agent-layer diagrams omit the independent reviewer | spec-validator (PROJECT_CONTEXT) + doc chore (Q8 PR) |
| 15 | m | `npm run lint` red on develop (`tests/config-server/tools/confine-hook-probe.test.ts:83` forbidden `require()`); `format:check` red (176 files); neither CI-gating | **Q8** |
| 16 | m | `trustList` dispatched but absent from `schemas/api-tools-v1.json`; `getStackConventions`/`getOverlayField` schema-catalogued + dispatch-listed but handler-less (`src/config-server/index.ts:144,147,179`) | **Q8** |
| 17 | m | SKILL.md:453 names library exports (`formatSprintSummary`/`FromEvents`) as orchestrator-callable; the MCP tool is `runSprintSummary` | **D3** |
| 18 | m | `independent-review-v1.json:125` metacharacter pattern refuses ordinary compound repro commands → findings drop `reproduction-unsafe`, starving renegotiation | **F9** (decision recorded) |
| 19 | m | Version-vocabulary incoherence: package `0.6.0` + "R1 skeleton" description vs `[shipped-in-v1.0]` markers; `getApiVersion` reports 0.6.0 | **Q8** (description), roadmap note below |
| 20 | m | SKILL.md:113 ships example `--spec specifications/roadmap-vote.md` — internal convention leaking to end-user prompt, missed by `lint-no-spec-ref` | **D3** |
| 21 | m | Splice-point keys hardcoded in four agent prompts with no lint against the overlay schema (gan-generator.md:32, gan-evaluator.md:65, gan-contract-proposer.md:99, gan-planner.md:34) | **Q8** |
| 22 | m | Clarifier output references a document schema that does not exist (BR-011) | **F9** |
| 23 | m | BR-013 / BR-015 verified not-reproducible but still open | tier-5 branch (close-outs) |

**Version-vocabulary note (finding 19).** `[shipped-in-v<release>]` markers refer to *release milestones* (v1.0 = the first release, unshipped — roadmap item "Pre-release chores"); `package.json` `version` (0.x minor bumps per the install-version discipline) is the *package* version. These are different counters by design, but nothing said so anywhere; this paragraph is now the recorded mapping, and Q8 retires the stale "R1 skeleton" package description.

## Fix plan — order and dependencies

Sequenced so each step unblocks or de-risks the next. One spec ≈ one PR into `develop` per the branching model.

| Step | Item | Depends on | Why this position |
|---|---|---|---|
| 0 | Hygiene chore: fix the eslint `require()` error, run `prettier --write` | — | One-commit chore; makes "develop is green" true before anything else claims it |
| 1 | **[H4](H4-confinement-hook-artifact-parity.md)** — hook artifact-allowlist parity + run-artifact catalog | — | Unbreaks `/gan` outright; everything downstream dogfoods through the hook |
| 2 | Land `feature/fix-order-plan-tier5-impl` (**E9** + BR close-outs), rebased onto develop | H4 (its own dogfood runs died on the hook gap) | Finished work; E10 builds on its verdict shape |
| 3 | **[E11](E11-agent-tool-grant-coherence.md)** — tool-grant & caller coherence, `lintCmd` fix | — (parallel with 2) | Removes the self-inflicted blocker class before the gate is exercised again |
| 4 | **[E10](E10-contract-review-wiring-and-negotiation-budget.md)** — first-pass contract-review wiring + negotiation budget | E9, H4 | The unwired gate and the ceiling exhaustion are the reported symptom |
| 5 | **[F9](F9-run-artifact-write-boundary.md)** — schema-gated run-artifact write boundary | H4 (catalog), E10 (names settled) | Closes the BR-001/002/003/005/016 cluster at one boundary |
| 6 | **[O4](O4-run-store-lock-and-recovery-hardening.md)** — lock lifecycle, store-root integrity, recovery guards, trace-drop halting | F9 (atomic-write contract) | Operability: a stuck repo and unrecoverable runs stop being possible |
| 7 | **[Q8](Q8-repo-gate-honesty.md)** — CI gating + parity lints + API-surface parity | H4, E11 (the catalogs/lints it wires into CI) | Closes the self-certification hole that let finding #1 ship |
| 8 | **[D3](D3-skill-executable-surface-reduction.md)** — SKILL.md executable-surface reduction | E10, O4, F9 | Largest and safest last; moves decisions server-side once the loop is correct |

**Verification path for the maintainer after step 4** (the symptom fix): re-run the hook probe above (expect exit 0 for every catalogued artifact), then run `/gan` with a small spec on a scratch repo and confirm in the run dir: `clarified-spec.md`, `spec.md`/`plan.md`, `sprint-1-contract-review-0.json` consumed (verdict `approved` → locked contract), `sprint-1-independent-review-A.json` present, and sprint 1 reaching the evaluator without a `LoopDetected` halt from proposer/reviewer attempts.

## Flagged for spec-validator (single-writer surfaces)

- PROJECT_CONTEXT.md § Code organization: agent roster lists 5 of 7 agents (missing `gan-clarifier.md`, `gan-reviewer-independent.md`); recommend replacing the enumeration with a pointer to `agents/`.
- PROJECT_CONTEXT.md § Code organization: the error-code enumeration duplicates `src/config-server/errors.ts`; recommend pointer-not-copy. New codes from O4/F9 (`StoreRootUnreadable`, `TraceWriteFailed`, `ArtifactValidationFailed`) will otherwise stale it further.
- PROJECT_CONTEXT.md § Conventions: fold the BR-016 `schemaVersion`-stamp convention once F9 lands (F9 § "Schema additions" carries the wording).

## What this audit did not change

No shipped spec was edited (immutability honoured). The roadmap gains a hotfix section cross-referencing the new specs; `runtime-knobs.md` gains O4's `gan runs unlock` row. The findings about prose-vs-enforcement (the BR cluster's root cause) are structural and recur until F9 + Q8 land; H4/E10 alone fix the symptom, not the class.
