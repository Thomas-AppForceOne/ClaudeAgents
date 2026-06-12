# D3 — SKILL.md executable-surface reduction

## Problem

`skills/gan/SKILL.md` is ~500 lines of load-bearing imperative procedure that a model must execute faithfully on every run — simultaneously the orchestrator implementation, the recovery state machine, and the user documentation. The audit (see [`_audit-2026-06-12-structural.md`](_audit-2026-06-12-structural.md) findings 9, 17, 20) shows the specific failure modes this scale produces:

1. **Enforced constants live twice.** The seed ceilings, the budget seed 12, and the `n × roleCount + 4` formula appear verbatim in SKILL.md *and* in `src/safety/` — two writable homes for values the server enforces; the prompt copy is the one agents actually read, and nothing keeps them equal. The clarifier's three-round limit exists *only* in prose — unenforceable and untestable.
2. **Decision tables execute client-side.** The recovery dispatch (status → action, five branches with per-branch caveats) is a prose table the LLM re-derives per run; the runs with improvised behaviour cluster exactly where prose is the only implementation.
3. **Prose names library symbols as callable.** SKILL.md instructs the orchestrator to use `formatSprintSummary` / `formatSprintSummaryFromEvents` — library exports, not MCP tools (the registered tool is `runSprintSummary`); and ships an example `--spec specifications/roadmap-vote.md`, a path shaped like this repo's internal convention that exists in no end-user repo.

D2 fixed prompt *hygiene* (verbosity, regions, spec-refs); this spec reduces the prompt's *executable* surface: every decision the server can make, the server makes — the `buildEvaluatorPlan` pattern (tool returns a decision as data; prose consumes it) applied to the rest of the loop. This is also the standing re-simplification discipline applied ahead of schedule, justified by incident data rather than a model bump.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — converts prose into calls to existing/new R7-pattern tools; no new ownership lane.
2. **Composable?** Yes — server-side decisions are testable in CI, reusable by `gan` CLI surfaces (T2), and stable under prompt edits.
3. **Owns durable structured state?** No new state; it relocates decision logic over existing state.
4. **Fits existing lanes?** Yes — the roadmap's own organising principle ("the orchestrator can call only what is exposed as a tool") taken to its conclusion.
5. **Stackable?** Yes — each migrated decision shrinks the obedience surface every other spec depends on.

## Proposed change

### 1. Constants: one home, prose reads the snapshot

- SKILL.md's numeric safety literals (per-role ceilings, budget seed, `+4` headroom, formula) are replaced by instructions to read the **resolved effective safety config** the orchestrator already obtains at run start; the values themselves live only in `src/safety/`. Prose keeps the *semantics* (what a ceiling is, what halts), drops the *numbers*.
- The clarifier round limit moves into the effective safety config: additive overlay field `clarifier.maxRounds` (default 3, range-checked like `draftTimeoutSeconds`), threaded through the existing resolver; SKILL.md reads it from the snapshot. The limit becomes testable and overlay-tunable.

### 2. Recovery dispatch becomes a tool

New MCP tool **`resolveRecoveryAction({ runId })`** (R7 pattern, dual-callable): reads the run's `progress.json` + trace and returns the dispatch decision as data — `{ action: "re-present-draft" | "re-enter-planner" | "re-enter-proposer" | "reset-and-respawn-generator" | "re-evaluate" | "refuse-terminal" | "state-corrupt", params: {...}, diagnostics: [...] }` — encoding the five status branches **and** O4's guards (terminal reject, corrupt state) in one tested function. SKILL.md's recovery section shrinks to: call the tool, execute the named action, surface the diagnostics. The per-branch caveat prose (base-commit reset semantics, partial-draft discard) moves into the tool's `params`/`diagnostics` contract and its unit tests.

### 3. Prose-reference corrections

- `formatSprintSummary` / `formatSprintSummaryFromEvents` references become `runSprintSummary` (the registered tool).
- The `--spec` example path becomes a neutral end-user path (`docs/feature-spec.md`).
- A line-by-line pass deletes any remaining instruction that names a non-tool symbol as callable (the Q8 parity lints guard artifacts and splice keys; this pass covers tool names, verified by AC 6).

### 4. What deliberately stays prose

Interactive surfaces (clarifier menu, trust prompt), spawn sequencing, and the halt *contract* stay in SKILL.md — they are orchestration, not decisions, and moving them server-side would re-create E6's pluggable-role seam prematurely. This spec migrates **decisions with testable inputs/outputs** only. Expected net effect: SKILL.md shrinks by roughly a quarter while gaining zero new behaviour — behaviour-preserving except where prose contradicted the server, where the server wins.

## Schema additions

- `overlay-v1.json` — additive `clarifier.maxRounds` (integer, default 3).
- `api-tools-v1.json` — `resolveRecoveryAction` entry.

## Acceptance criteria

1. **No numeric safety literals in prose.** `grep -nE 'ceiling (of |)3|budget.*12|roleCount \+ 4' skills/gan/SKILL.md` returns 0 hits; the safety sections instruct reading the resolved config.
2. **Round limit enforced.** `clarifier.maxRounds` resolves through the cascade; an overlay value of 5 permits a 5th round, the default still forces choose-at-3 (unit-tested in the resolver; prompt reads the resolved value).
3. **Dispatch parity.** For each O2 status value plus the corrupt/terminal cases, `resolveRecoveryAction` returns the action SKILL.md's pre-D3 table specified (golden tests pin the mapping); SKILL.md's recovery section contains no status-conditional logic beyond "execute the returned action".
4. **Reference corrections.** `grep -c 'formatSprintSummary' skills/gan/SKILL.md` returns 0; `grep -c 'specifications/' skills/gan/SKILL.md` returns 0.
5. **Behaviour preservation.** The evaluator-pipeline-check fixtures and the full vitest suite pass unchanged; no agent prompt changes in this spec.
6. **Tool-name parity.** Every backtick-quoted callable name in SKILL.md resolves to a registered MCP tool or `gan` subcommand (one-off audit script in the PR; candidates for promotion into the Q8 lint family if drift recurs).
7. **D1 markers consistent.** Sections whose behaviour moved server-side carry updated status markers; no `[deferred-to-v1.1]` marker survives on a branch this spec made operative.

## Version bump: minor

New MCP tool + additive overlay field — installed-package changes; the PR minor-bumps `package.json`.

## Dependencies

- **E10, F9, O4** (hard) — the loop must be correctly wired, write-gated, and guard-complete before its prose is compressed; D3 freezes the *final* shape, not an intermediate one.
- **D1 / D2** (shipped) — marker vocabulary and hygiene lints this spec operates under; cross-referenced, never edited.
- **R7** (shipped) — the tool-bridge pattern being extended.

## Bite-size note

Two slices, one PR each if preferred: (1) `resolveRecoveryAction` + golden dispatch tests + recovery-section rewrite; (2) constants/round-limit migration + reference corrections + the final D2-style read-through (which doubles as the roadmap's standing "final prompt-hygiene re-check" chore). Land last in the audit sequence.
