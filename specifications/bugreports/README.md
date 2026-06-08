# Bug Reports — GAN system observed defects

Bug reports filed against the ClaudeAgents framework based on analysis of GAN runs under `/Users/taa/.gan-runs-data/` (8 runs across 3 project roots, dates 2026-05-30 → 2026-06-08).

All reports were filed with **Status: Needs verification** — findings from offline analysis of run artifacts, not yet reproduced against the running framework or fix-validated.

**Update 2026-06-08:** all 16 reports have been verified against the live codebase and run artefacts. See [VERIFICATION-SUMMARY.md](VERIFICATION-SUMMARY.md) for the verdict table, [ROADMAP-CROSS-REFERENCE.md](ROADMAP-CROSS-REFERENCE.md) for which findings the roadmap already accepts as known v1.0 gaps vs. genuine defects, and [FIX-ORDER-PLAN.md](FIX-ORDER-PLAN.md) for the proposed implementation sequence. Verdicts: 11 confirmed, 3 partially-valid, 2 not-reproducible. Per-bug verification reports live alongside each BR as `BR-XXX-verification.md`; each BR file has a "Verification update" footer summarising the verdict and corrections.

## Index

| ID | Severity | Title |
|---|---|---|
| [BR-001](BR-001-trace-emission-silently-absent.md) | Blocker | Trace emission silently absent on entire runs |
| [BR-002](BR-002-independent-review-schema-not-enforced.md) | Blocker | `independent-review-v1.json` schema not enforced at write time |
| [BR-003](BR-003-progress-json-has-no-canonical-schema.md) | Blocker | `progress.json` has no canonical schema; field naming varies wildly across runs |
| [BR-004](BR-004-evaluator-output-filename-inconsistent.md) | High | Four distinct filenames for the same evaluator-output artifact |
| [BR-005](BR-005-generator-objection-no-schema-no-handler.md) | High | Generator-objection artifact has no schema and is not consumed by the orchestrator |
| [BR-006](BR-006-contract-reviewer-rubber-stamps.md) | High | Contract-reviewer rubber-stamps drafts without producing change requests |
| [BR-007](BR-007-proposer-does-not-validate-cited-names.md) | High | Proposer does not validate that scripts / files / symbols named in criteria actually resolve |
| [BR-008](BR-008-evaluator-prompt-digest-missing-from-evidence.md) | Medium | Evidence files carry no evaluator-prompt digest; mid-run protocol changes are invisible |
| [BR-009](BR-009-harness-conditions-land-in-free-text-concerns.md) | Medium | Evaluator harness-condition observations land in free-text `concerns` field; signal does not aggregate |
| [BR-010](BR-010-newly-shipped-agents-not-invoked-in-own-run.md) | Medium | Agents shipped mid-run are not invoked on subsequent sprints of that same run |
| [BR-011](BR-011-clarified-spec-has-no-structure.md) | Medium | `clarified-spec.md` is free-form markdown with no structural validation |
| [BR-012](BR-012-evaluator-logs-undocumented-parallel-artifact-channel.md) | Medium | `evaluator-logs/` is an undocumented parallel artifact channel outside trace/schema discipline |
| [BR-013](BR-013-telemetry-config-shipped-without-spec.md) | Medium | `telemetry/config.json` ships ad-hoc without spec coverage; matches T4 (v1.1) |
| [BR-014](BR-014-web-node-lintCmd-is-test-runner.md) | Low | `web-node` stack declares `lintCmd: "vitest run"` — the test runner, not a linter |
| [BR-015](BR-015-doc-surface-criteria-duplicate-per-touched-file.md) | Low | Documentation-surface criteria duplicate per touched file in sprint contracts |
| [BR-016](BR-016-schemaVersion-field-inconsistent-across-artifacts.md) | Low | `schemaVersion` field inconsistently present across artifact files |

## Severity definitions

- **Blocker** — data integrity / silent failure / downstream consumers cannot rely on the artifact. Must be addressed before any cross-run tracking or downstream observability tool can be shipped.
- **High** — functional but wrong; produces misleading output or skips a verification step the spec promises.
- **Medium** — friction, signal loss, or convention drift that compounds over time; not breaking today.
- **Low** — efficiency / clarity / documentation; safe to defer but worth a follow-up sprint.

## Filing context

These reports are derived from offline analysis of:
- `/Users/taa/.gan-runs-data/ClaudeAgents-dea5f7879cf0/runs/` (1 run — original E8 implementation)
- `/Users/taa/.gan-runs-data/claudeagents-5f2b0a723ee9/runs/` (5 runs — M4, O2 recovery, O1, roadmap-next-task, D1)
- `/Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/` (2 runs — non-Node dogfood on a Twig/CSS site)

Each report includes concrete `Steps to reproduce` against on-disk artifacts so a verifier can confirm the finding without re-running `/gan`.

## Related roadmap items

Several bugs map directly to v1.0 roadmap entries that have not yet shipped:
- BR-001, BR-002, BR-003 — directly stress the v1.0 "Known gaps accepted at v1.0" entries on safety-obedience, trace-emission fidelity, and per-stack overlay overrides.
- BR-013 — overlap with T4 (v1.1 spec, partially implemented).
- BR-006, BR-007 — overlap with E8's contract-reviewer rewrite (shipped) but reveal coverage gaps.

See also the analysis discussion in the run-data review session (2026-06-08).
