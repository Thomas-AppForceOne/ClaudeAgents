# Bug Report Verification — Summary

Verification pass over `BR-001` through `BR-016` against the live codebase at `/Users/taa/AppForceOne/projects/ClaudeAgents-verify/` and on-disk run artefacts under `/Users/taa/.gan-runs-data/`. Run on **2026-06-08**.

This pass is verification only. No source files were modified; the 16 original `BR-XXX-*.md` files are byte-unchanged from before the run (identical creation mtimes, all subsequent timestamps belong to new `*-verification.md` files).

## Verdict table

| BR-ID | Severity | Verdict | Confidence | Verifier model |
|---|---|---|---|---|
| [BR-001](BR-001-verification.md) | Blocker | confirmed | high | opus |
| [BR-002](BR-002-verification.md) | Blocker | confirmed | high | sonnet |
| [BR-003](BR-003-verification.md) | Blocker | partially-valid | high | sonnet |
| [BR-004](BR-004-verification.md) | High | partially-valid | high | sonnet |
| [BR-005](BR-005-verification.md) | High | confirmed | high | opus |
| [BR-006](BR-006-verification.md) | High | confirmed | high | opus |
| [BR-007](BR-007-verification.md) | High | confirmed | high | opus |
| [BR-008](BR-008-verification.md) | Medium | confirmed | high | sonnet |
| [BR-009](BR-009-verification.md) | Medium | confirmed | high | sonnet |
| [BR-010](BR-010-verification.md) | Medium | confirmed | high | opus |
| [BR-011](BR-011-verification.md) | Medium | partially-valid | high | sonnet |
| [BR-012](BR-012-verification.md) | Medium | confirmed | high | sonnet |
| [BR-013](BR-013-verification.md) | Medium | not-reproducible | high | sonnet |
| [BR-014](BR-014-verification.md) | Low | confirmed | high | sonnet |
| [BR-015](BR-015-verification.md) | Low | not-reproducible | high | sonnet |
| [BR-016](BR-016-verification.md) | Low | confirmed | high | sonnet |

## Breakdown

**By verdict (16 total):**

| Verdict | Count | BRs |
|---|---|---|
| confirmed | 11 | BR-001, 002, 005, 006, 007, 008, 009, 010, 012, 014, 016 |
| partially-valid | 3 | BR-003, 004, 011 |
| not-reproducible | 2 | BR-013, 015 |
| superseded | 0 | — |
| needs-clarification | 0 | — |

**By confidence:** high 16, medium 0, low 0.

**By severity × verdict:**

| Severity | confirmed | partially-valid | not-reproducible |
|---|---|---|---|
| Blocker (3) | 2 | 1 | 0 |
| High (4) | 3 | 1 | 0 |
| Medium (6) | 4 | 1 | 1 |
| Low (3) | 2 | 0 | 1 |

## `needs-clarification` bugs

None.

## Notes for the fix-planner

These are items each verifier surfaced under "Concerns / caveats" that go beyond what the original bug report stated. They are the differences the fix-planner needs to plan around — not new bugs and not fixes.

### BR-001 (confirmed, Blocker — trace emission silently absent)

- The bug report cites `tests/config-server/tools/run-context.test.ts` for the R7 unit tests; the actual `emitTraceEvent` tests live at `tests/config-server/tools/trace.test.ts` (e.g. lines 116-167, 418, 458, 539). Minor citation slip, verdict unaffected.
- Milestone slots of `emitTraceEvent` *did* fire on the D1 run (clarification-start, all-sprints-passed). The `agentAttempt` and `llmCall` slots are the ones skipped — the gap is per-call-site obedience, not a global wiring failure.
- The workshop-site absence cannot be explained by shared server-process state (different project root) — the orchestrator may skip milestones too in some runs.
- `reconstructRecoveryState` has no fallback when the trace is degenerate; a `--recover` against any of the three affected runs would silently read zero attempts.

### BR-002 (confirmed, Blocker — `independent-review-v1` schema not enforced)

- Two artefacts (`e220/sprint-1-B`, `1588/sprint-2-A`) fail validation on the `reproductionCommand` safety `pattern` — a violation class the bug report did not enumerate.
- `validateFindingsTool`'s `UNSAFE_COMMAND_CHARACTERS` regex partially mitigates shell-metacharacter injection but does nothing for the structural violations (wrong field names, missing required fields).
- The `5cc0` citation in the root cause refers to `schemas-bundled.ts` exports (correct), not to artefacts in that run (which predate E8 and use `sprint-N-review.json` naming).
- The same write-time gap likely exists for the evaluator evidence bundle — needs separate confirmation before extending the fix.

### BR-003 (partially-valid, Blocker — `progress.json` schema discipline)

- The root-cause claim "no `schemas/progress-v1.json` exists" is **false**: it shipped in PR #37 (commit `5b4acb6`, 2026-06-01). The true gap is incomplete write-boundary coverage — MCP-tool writes are schema-gated, but direct orchestrator writes bypass them.
- Two runs (`9f56`, `70ef`) already validate clean against the current schema, proving the shape is achievable.
- `startedAt` (present in 5 of 8 runs) is missing from the schema entirely — only `terminalAt` exists.
- The schema has no `sprints[]` array; two runs (`1588`, `5cc0`) wrote one with incompatible shapes.
- Historical runs are permanently non-conforming; a graceful-read path is needed for `--recover` and reporting tools.

### BR-004 (partially-valid, High — evaluator-output filename inconsistency)

- The root cause is wrong: `agents/gan-evaluator.md` and `SKILL.md` have consistently prescribed `sprint-{N}-feedback-{attempt-letter}.json` since the R7 commit (`fba3552`), which predates all four divergent filenames. The drift was LLM runtime deviation, not spec drift.
- The O1 coexistence case isn't just a naming variant — `evaluation.json` and `feedback-A.json` carry different *schema shapes* (legacy `passes/criterionVerdicts/score/threshold` vs. canonical `evaluator-evidence-bundle-v1`).
- The "roadmap-next-task" run named in the report does not exist on disk; other newer runs do.
- The H1 confinement hook's write pattern may not be tight enough to reject the non-canonical variants — worth checking.

### BR-005 (confirmed, High — generator-objection has no schema/handler)

- `progress.json` shows `currentAttempt: 2` on the sprint where the objection was raised, suggesting the generator re-ran on the original contract on attempt B rather than the proposer being consulted — the orchestrator likely treats OBJECTION-RAISED stdout as just another failed attempt.
- `retirements.md` (lines 23, 40) records that an older `objection.schema.json` was retired during E1 with explicit "rewrite or drop". The current absence may be an unintentional permanent drop.
- `schemas/progress-v1.json` has no `objections[]` field — cross-run objection counts require directory scans.
- No automated fixture in `tests/` exercises end-to-end objection handling.

### BR-006 (confirmed, High — contract-reviewer rubber-stamps)

- Verdict-shape varies within the same run: sprint 1 emits `decision: "approve"`, sprints 2–6 emit `verdict: "approved"`. Downstream consumers that hard-code one key will mishandle.
- Only the E8 self-build run was checked. The "general pattern across newer runs" claim remains unverified cross-run.
- BR-006 and **BR-007** attribute the *same observed defect* (fabricated `npm run test-*` script names) to two different roles — proposer for emitting, contract-reviewer for not catching. Both attributions hold and either fix layer is plausible.

### BR-007 (confirmed, High — proposer doesn't validate cited names)

- The bug report's literal reproduction regex (`"test-house-rules"`) does not match because the names are embedded inside backtick-quoted shell tokens in `description`. Regex needs the quotes removed.
- The evaluator's "intent satisfied" behaviour is partly licensed by its own prompt — a proposer-only fix may not close the loop; coordinated tightening of evaluator latitude may also be needed.
- The "names" scope is unstated. Three reference kinds (npm scripts, file paths, exported symbols) have very different cost/precision profiles for a v1 pre-flight.
- Only one run / one sprint examined.

### BR-008 (confirmed, Medium — evaluator-prompt digest missing)

- The bug report says the rewrite "landed in sprint 5"; artefacts show the shape change between sprint 1 and sprint 2. Core observable (mixed shapes in one run) is real either way.
- `additionalProperties: false` at root and `evidence` levels means a digest stamp added by an orchestrator change today would be rejected by any schema-validating consumer — coordinated schema + orchestrator + agent change required.
- SKILL.md describes the artefact as `sprint-N-feedback-A.json` but disk shows `-evidence-A.json`. Cross-references BR-004 — this pre-existing naming inconsistency could confuse a fix-planner following SKILL.md.

### BR-009 (confirmed, Medium — harness conditions in free-text `concerns`)

- The `criterion` definition in `evaluator-evidence-bundle-v1.json` does **not** set `additionalProperties: false` (unlike the top-level object, `evidence`, `deltaFromContract`, `verdictSummary`). The ad-hoc `concerns` field is silently accepted. Fix-planner must decide between strict additional-properties, formal promotion of `concerns`, or removal.
- Same `sprint-1-evidence-A.json` has undocumented top-level fields `overall` and `summary` — suggests an older/deviant evaluator prompt version was in use for that run.
- Cross-references **BR-012**: workshop-site runs expressed the same class of environmental observation through `evaluator-logs/` directories instead. Two symptoms of the same missing typed channel.
- Aggregation impact is latent — no `gan health` command currently consumes `harnessConditions` counts.

### BR-010 (confirmed, Medium — newly-shipped agents not invoked in own run)

- The E8 run's six sprints all passed first-try (15/15…20/20 criteria); even with the reviewer live, the renegotiation loop would have had nothing to escalate. The bug is structural (the artefact simply doesn't exist), independent of whether the reviewer would have flagged anything.
- The E8 run's `trace/` directory is empty — trace events cannot prove non-invocation; artefact absence is the only available signal but is sufficient.
- Run-data is in `~/.gan-runs-data` (centralized per F7), not in the worktree at `~/AppForceOne/projects/ClaudeAgents-verify/.gan-state/`.

### BR-011 (partially-valid, Medium — `clarified-spec.md` has no structure)

- Scope of variation is **narrower than described**: 7 of 9 runs have the canonical six sections. The pervasive-variation framing is an overstatement — the issue is an enforcement gap, not observed cross-run divergence.
- Run `5cc0` is dated 2026-05-30; the E5 clarifier merged 2026-05-25. The `clarified-spec.md` there is a verbatim copy of the E8 spec — likely a pre-schema agent or a no-op clarifier.
- Two May-31 runs (`e220`, `9f56`) have correct sections but no `schemaVersion: 1` YAML frontmatter — smaller violation.
- `E5-spec-clarification.md` and `SKILL.md` both reference a "document schema" that does not exist as a file. Fix-planner must choose: (a) create the schema and wire it in, (b) remove the spec language, or (c) implement a section-presence lint.
- Bug report's count of "6 of 8 runs" should be "9 runs total" against today's data.

### BR-012 (confirmed, Medium — `evaluator-logs/` undocumented channel)

- Only one project root is affected (`workshop-site-71c837164a90`). The other two roots have no `evaluator-logs*`. No agent file references `evaluator-logs` either — the writing logic is invisible in the spec layer.
- Naming is already inconsistent within the single run: `evaluator-logs/` uses criterion prefixes (`c1-c5`, `c6`), `evaluator-logs-B/` uses numeric prefixes (`01`, `02`).
- `c7-base-attempt-b.stderr` is 0 bytes while the `.json` sidecar is 979 KB — asymmetric capture matches the report's "unpredictable" flag.
- Cross-references **BR-009**.

### BR-013 (not-reproducible, Medium — telemetry config without spec)

- Root-cause claim is wrong on three counts: (1) count is 2 of 9 runs, not 1 of 8; (2) **O3** (`O3-telemetry-semantics.md`, PR #39 merged 2026-06-06) is the authoritative spec for `telemetry/config.json`; (3) the payload matches the O3 schema exactly, **not** T4's `runConfiguration` trace-event shape (which carries `frameworkVersion`, `configDigest`, `roles`, `trustRung`, `safetyKnobs` — none of which appear in `config.json`).
- The 7 runs without `config.json` all predate the O3 merge timestamp — the expected pre/post-O3 split, not a bug.
- O3 and T4 are complementary (operator-facing artefact vs. structured trace event), not competing spec authorities.

### BR-014 (confirmed, Low — `web-node` lintCmd is test runner)

- Direct evidence of duplication harm is confirmed in one run (`e220`), where evaluator evidence labels the execution `"(the lintCmd)"` and notes it "replays the same 25 failures" as `npm test`.
- The E8 run uses an older file format (`sprint-N-evidence-A.json`, not `sprint-N-evaluator-evidence-A.json`) and has no evaluator evidence mentioning `lintCmd` by name.
- On a generic user project where `npm test` is *not* configured for Vitest, `vitest run` as `lintCmd` would fail outright rather than merely duplicate.
- `lintCmd` does not currently support `absenceSignal: warning` (unlike `auditCmd` and `docLintCmd`); declaring it absent would require a schema change.

### BR-015 (not-reproducible, Low — doc-surface criteria duplicate per file)

- Counts contradict the report: sprint 4 has 4 doc-surface criteria (not 8), sprint 6 has 4 (matches numerically but without the duplication framing being meaningful). Every sprint shows one criterion per surface, not per file.
- A real distinct anomaly was found during verification: sprints 1–5 use bare names (`public_contract_completeness`); sprint 6 uses the spec-mandated stack-qualified form (`web_node_public_contract_completeness`). The bare-name form is the deviation, not the duplication.
- A second real distinct gap: the `web-node` stack in `snapshot.json` carries no `documentationSurfaces` array. The proposer is generating these criteria from internalized knowledge rather than from stack declarations — the template-instantiation protocol described in the spec is not actually the mechanism being used.
- Run artefacts are not under git, so an older version of these JSON files matching the symptom cannot be recovered.

### BR-016 (confirmed, Low — `schemaVersion` inconsistent across artefacts)

- **Validation paradox**: the two `progress.json` files that DO carry `schemaVersion=1` (c238, 1588) would **fail** strict validation today because `progress-v1.json` declares `additionalProperties: false` with no `schemaVersion` property. Adding `schemaVersion` to the schema requires either making it optional or planning a breaking migration.
- Both c238 and 1588 carry `schemaVersion=1` but are missing 9–11 required fields — `schemaVersion=1` does *not* mean "conforms to v1".
- Within-run inconsistency: run 1588 emits `schemaVersion=1` only in sprint-1's independent review; sprints 2–4 omit it. Confirms the "some prompt examples include it, others don't" hypothesis.
- Telemetry artefacts use an `envelope.schemaVersion` wrapper rather than bare top-level field — fix-planner must decide whether a cross-schema convention follows the envelope pattern.
- File count: "5" independent-review runs is correct as 5 distinct directories (10 files: e220 A+B; 70ef 2 sprints; 1588 4 sprints).

## Reproduction step issues / deeper bugs surfaced during verification

- **BR-007** — the literal `grep -E '"test-house-rules"|"test-no-spec-ref"'` recipe returns no rows because the names are embedded inside backtick-quoted shell tokens within longer description strings, not as JSON keys/values with surrounding double quotes. The recipe needs the quotes removed; the underlying symptom is unaffected.
- **BR-004** — zsh `no matches found` warning when the loop runs against the workshop-site run `20260608T171254-22af` (which has no sprint-1 files). Cosmetic; output for other runs is correct.
- **BR-008** — reveals a pre-existing naming inconsistency between SKILL.md (`sprint-N-feedback-A.json`) and disk (`-evidence-A.json`). Likely related to BR-004 (filename drift) but not directly part of the digest issue.
- **BR-009** — reveals that the `criterion` definition lacks `additionalProperties: false` even though the surrounding shapes do. A schema-tightening pass would surface this independently.
- **BR-015** — reveals that the `web-node` stack carries no `documentationSurfaces` array in the snapshot, which contradicts the proposer spec's template-instantiation mechanism. A genuine, distinct gap from the one filed.
- **BR-016** — the two `progress.json` files carrying `schemaVersion=1` are *more* non-conforming than the ones without it (missing 9-11 required fields). The stamp is currently a misleading signal.

## Cross-bug observations

- **BR-006 ↔ BR-007** attribute the same observed defect (fabricated `npm run test-*` script names in sprint contracts) to two different roles in the same pipeline. Both attributions hold and both fix layers are plausible.
- **BR-009 ↔ BR-012** are two symptoms of the same gap: no sanctioned channel for captured shell/browser output or environmental harness observations from the evaluator. BR-009 routes the observation through a free-text per-criterion `concerns` array (1 of 19 evidence files), BR-012 routes it through ad-hoc sidecar `evaluator-logs/` directories (1 of 3 project roots). A fix to one without the other leaves the other channel orphaned.
- **BR-004 ↔ BR-008** both touch the canonical-vs-emitted name for the evaluator output. BR-004 is about filename drift across runs; BR-008 incidentally notes SKILL.md describes the artefact as `sprint-N-feedback-A.json` while disk emits `-evidence-A.json`. Coordinated cleanup may be cheaper than two passes.

## Contradictions between verifiers

None observed. Where a verdict diverged from the report's framing (BR-003, BR-004, BR-011, BR-013, BR-015), only one verifier examined that report, so there is nothing to reconcile across verifiers.

## Guardrail audit

- All 16 verifiers returned a `WROTE:` line pointing to the expected `BR-XXX-verification.md` path. No silent verdict-only returns.
- No verifier proposed a fix; "fix-planner" mentions in the verification reports were exclusively flagged under the prompt template's explicit "things a fix-planner needs to know" slot, which is in scope.
- No source files under `src/`, `agents/`, `schemas/`, or `specifications/` (outside `bugreports/`) were modified — `git status` shows only `?? specifications/bugreports/` as untracked.
- Original 16 `BR-XXX-*.md` files have identical mtimes (`2026-06-08 19:53:30`), all preceding every verification timestamp — they are byte-unchanged.
