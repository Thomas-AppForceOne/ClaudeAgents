# 09 — Project overlay file

## Problem

Projects often need small, local adjustments to `/gan` behavior without forking agents or forking the stack files: add a criterion that always applies, override stack detection for a polyglot repo where dispatch picks wrong, tighten a threshold. Today the only option is shadowing the agent in `.claude/agents/`, which forks hundreds of lines of prompt to tweak one setting.

## Proposed change

Add a project-scoped overlay file: `.claude/gan/project.md`. The repo owns the path and schema; the user opts in by creating the file. Missing file = no overlay, defaults apply.

Minimal v1 splice points:

```
---
schemaVersion: 1
---

## stack.override
Force detection result. Useful when auto-detection is ambiguous in polyglot repos.

- android, kmp

## proposer.additionalCriteria
Criteria appended to every contract in this project.

- name: no_new_kapt
  description: No new `kapt` annotation processors introduced; prefer KSP.
  threshold: 9

## generator.additionalRules
Free-text rules appended to the generator's secure-coding standards, for this
project only.

- Do not introduce new reflection-based DI frameworks.

## evaluator.additionalChecks
Commands appended to the evaluator's security pass. Each must produce
machine-readable output and a clear pass/fail signal.

- command: "./gradlew detekt"
  on_failure: "blockingConcern"

## runner.thresholdOverride
Override the per-criterion default threshold for this project.

- 8
```

Rules:

- Agents read `project.md` **after** loading the active stacks; overlay adds, never subtracts principles. It cannot delete a baseline security requirement.
- The schema is strictly additive across versions; `schemaVersion: 1` fixes the v1 splice-point set. New splice points get `schemaVersion: 2` and agents refuse to load higher versions than they know.

## Acceptance criteria

- A `project.md` with `proposer.additionalCriteria` causes the listed criteria to appear in every generated contract for that project.
- A `project.md` with `evaluator.additionalChecks` runs those checks during evaluation; a failing command produces a blocking concern.
- A `project.md` with `stack.override` bypasses auto-detection and activates the named stack(s) directly.
- A malformed `project.md` halts the run with a clear error — never silently ignores fields.
- Missing `project.md` is a no-op; agents behave exactly as Phase 2/3 without overlay.

## Dependencies

- 04, 05 (stack.override only meaningful once stacks exist).

## Value / effort

- **Value**: high. This is the main user-facing customisation lever.
- **Effort**: medium. Schema discipline matters: every splice point added here becomes a contract the repo cannot break. Start with the five above and resist growth until real cases arrive.
