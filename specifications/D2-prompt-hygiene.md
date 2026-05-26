# D2 — Prompt hygiene

## Problem

The shipped agent prompts and the orchestrator skill carry the right *content* with the wrong *packaging*: precise behaviour buried under ceremony. This is an execution-fidelity risk, not an aesthetic one — these files run live, in the model's context, on every invocation, and the load-bearing control flow competes for attention with rationale, self-quotation, and repetition.

Concretely:

- **`skills/gan/SKILL.md` is ~8,500 words — ~41% of the entire prompt corpus** — and reads like a specification defending itself rather than instructions to an executor: it explains *why* throughout ("a deliberate consistency choice"); it **quotes itself** (a section reproduces a contract verbatim, restating a step already in the flow); the three safety sections (per-role ceiling, sprint budget, edit-oscillation) repeat the **same** "Timing / Mechanism / On-a-halt" wrapper ~3×; and it carries internal `specifications/*` and "per `<CODE>`" cross-references in a file that ships to end-user repos with no `specifications/` directory.
- **The six agent prompts repeat boilerplate verbatim:** the snapshot-is-data paragraph (all 6), "do not call the Configuration API yourself" (~13 occurrences), a near-identical `## Errors` section (6 copies), the `code/file/field/line/message` field list (7 copies), and "do not reference ecosystem-specific tools by name" (repeated within and across prompts).

Two harms follow. First, **execution fidelity**: ceremony surrounding a load-bearing instruction makes it less salient. Second, a **boundary violation**: per `CLAUDE.md`, the shipped product (`agents/`, `skills/gan/`) must never carry repo-internal process, yet the internal `specifications/*` references do exactly that — the class of leak `lint-no-stack-leak` and `test-error-text` already police on adjacent axes, with no backstop yet for spec references.

D2 is a **behaviour-preserving** refactor: it removes ceremony and factors duplication while keeping every operative rule, schema, rubric, and catalog intact. It adds no primitive, splice point, runtime knob, or agent surface, so the five-question relevance filter does not apply — it earns a slot as the hygiene pass that lowers execution-fidelity risk on the most load-bearing prompt in the framework and closes the spec-reference boundary leak. It is a **standalone spec** (not folded into D1): its deliverable — a prompt refactor plus a new lint — is distinct from D1's diagnostic-message work, though it depends on D1 (below).

## Proposed change

Three slices, none of which changes what any agent *does*.

### 1. De-verbose `SKILL.md`

- **Collapse the shared halt machinery, preserving every per-trigger distinction.** The three safety sections share a "Timing — attempt-start boundaries / Mechanism — trace is the only counter / On-a-halt sequence" wrapper that can be stated **once**. But the three triggers are **not** three copies of one rule, and the collapse must preserve all of the following per-trigger distinctions (a checklist the AC enforces):
  1. **Which roles are checked** — per-role ceiling: multi-attempt roles only (proposer, generator); sprint budget: *every* role including single-attempt clarifier/planner; oscillation: generator only.
  2. **The counter substrate** — ceiling/budget read attempt *counts*; oscillation reads an *edit-fingerprint history with post-rejection flags* (a different substrate).
  3. **The trigger logic** — budget sum vs `n × roleCount + 4` derivation; oscillation's direct-repeat-on-second + 3-cycle + post-rejection guard.
  4. **The error builder** — three distinct factories (`createLoopDetectedError`, `createSprintBudgetError`, `createEditOscillationError`) with distinct `reason`/`role` payloads (`role: "sprint"` is synthetic).
  5. **Gating** — oscillation alone is gated by the `oscillationDetection` flag.
  The result: one shared halt-contract block plus three trigger definitions that each state items 1–5 explicitly. "Short definition" must not drop any of the five.
- **Remove self-quotation** — delete the verbatim contract-reproduction blocks; state each step once.
- **Strip rationale prose** from runtime instructions — rationale lives in the introducing spec (A1/T1/F7), not the orchestrator instruction.

### 2. Factor a shared agent preamble — by build-time assembly, never runtime injection

The boilerplate repeated across all six agents — the snapshot-is-data framing, "do not call the Configuration API yourself", the `## Errors` structured-error discipline, "do not reference ecosystem-specific tools by name", and the confinement paragraph — is factored into **one canonical source partial** (`agents/_house-rules.md`).

**Mechanism: build-time assembly, not runtime injection.** The six `agents/*.md` are standard Claude Code subagents — frontmatter (`name`/`description`/`tools`/`model`) plus a static body, loaded by name; the orchestrator's spawn passes *data* (snapshot, paths, env vars), not prose prepended to an agent's instruction body. **There is no seam to inject a preamble at spawn time**, and an agent can be invoked outside the orchestrator, so the rules MUST live in the rendered agent file itself. Therefore:

- The **committed, shipped `agents/*.md` are self-contained** — each contains the full house-rules text inlined.
- The **single source of truth** is `agents/_house-rules.md` plus each agent's role-specific body; a build/check step (an R4 maintainer script) asserts that every committed agent file's house-rules section is **byte-identical** to the partial. Editing a rule means editing the partial; the check fails CI if a committed agent drifts. The check is **CI-enforced** (and may additionally be wired as a pre-commit hook); because the committed agent files are the shipped artifacts, a hand-edited agent that drifts from the partial ships only until CI catches it — the committed file is always self-contained and loadable, so drift is a correctness-of-source issue, never a missing-rules-at-runtime issue.
- This achieves the "one fact, one home" benefit **without** the rule-dropping failure mode of runtime injection: the rules are present where they load, every time, for every caller.

Each agent keeps its role-specific content (the generator's secure-coding standards, the evaluator's rubric and bundle shape, the clarifier's gap catalog — the specificity that earns its length stays).

### 3. Strip internal spec references from the shipped product — classify first, then lint

Internal references are not uniform; some are pure ceremony and some are **load-bearing pointers to behaviour the orchestrator/agents must enact**. The strip is two-step:

- **Classify every reference** in `agents/` and `skills/gan/` as *ceremony* (delete the reference; nothing else changes) or *behaviour-bearing* (the cited fact must be **inlined** as a self-contained rule; only the citation path is deleted). Known behaviour-bearing references that MUST be inlined, not just deleted: the **F4** forbidden-ecosystem-token rule the orchestrator enforces in the banner/help text; the **C1** template-instantiation rule the proposer follows to source security criteria; and the **F2** structured-error field list (`code/file/field/line/message`) the agents must preserve verbatim. An AC verifies each inlined fact is present after the strip.
- **Add a CI lint** (`lint-no-spec-ref`, or an extended `lint-no-stack-leak` scope) over `agents/` and `skills/gan/` that fails on internal-reference forms — `specifications/<CODE>` paths **and** prose codes including possessives and bare forms (`per F4`, `C1's`, `F2`) — with an **allowlist** for genuine user-facing surfaces: the `--help` EXAMPLES region (which legitimately shows `/gan --spec specifications/<file>` as a user example) and any `--spec` sample path. The allowlist MUST be **line/region-scoped, not whole-file**: allowlisting the EXAMPLES `--spec` line must not exempt the rest of `SKILL.md` from the scan. (The existing `lint-no-stack-leak` allowlist is whole-file path-keyed; reusing that tier as-is would silently gut coverage on the largest target — `lint-no-spec-ref` needs finer granularity.) The lint is the permanent backstop, exactly as `lint-no-stack-leak` backstops ecosystem tokens.

### What D2 does not do

- It does **not** change any agent's behaviour, flow, schemas, rubrics, or catalogs. Same rules, sourced once and stated plainly.
- It does **not** trim behavioural specificity (evidence-bundle shape, secure-coding standards, scoring rubric, gap catalog) — that earns its length and stays.
- It does **not** use runtime preamble injection (the rejected mechanism), and it does **not** delete a behaviour-bearing fact when it deletes its citation.
- It does **not** edit shipped specs — it **replaces** the product prompt bodies in one PR (replacement, not migration, per the do's-and-don'ts), naming what it supersedes (the prompt content E1/E5/Q5/Q6/E8 authored); retirement rows land at merge.

## Surface additions

- **`agents/_house-rules.md`** (new source partial) and an **R4 build/check** asserting committed agents match it.
- **New lint** `lint-no-spec-ref` (or extended `lint-no-stack-leak` scope) under `scripts/`, wired to CI. No data schema, no runtime knob.

## Acceptance criteria

### Automated checks

- **Operative-rule inventory preserved (the real gate).** Enumerate every operative rule in the current `SKILL.md` — each MUST/error-code/timing-boundary/flag-behaviour (e.g. the three distinct halt error-builders, the post-rejection guard, the `--reset-attempts` standalone rejection, the snapshot-enrichment requirement, the auto-approve timeout range). A test asserts each maps to a line in the refactored file. Word-count reduction (target ≥30%) is reported as an **advisory** metric, not a gate — fidelity is the gate, not volume.
- **House-rules parity.** Every committed `agents/*.md` contains the house-rules text byte-identical to `agents/_house-rules.md`; the build/check fails if any agent drifts or omits it. (Guards against the rule-dropping failure mode.)
- **Inlined facts present.** After the spec-reference strip, the F4 forbidden-token rule, the C1 instantiation rule, and the F2 error-field list are present **inline** in the relevant prompts (not merely de-cited).
- **`lint-no-spec-ref` green with correct scope.** Zero internal-reference forms (including possessive/bare codes) in `agents/` + `skills/gan/`, while the `--help` EXAMPLES `--spec` sample path is allowlisted and does not trip it.
- **Safety-collapse completeness.** The collapsed halt section still expresses all five per-trigger distinctions (roles checked, counter substrate, trigger logic, error builder, gating) — verified against the checklist in §1.
- **`lint-no-stack-leak`, `test-error-text`, and `lint-status-markers` (D1) remain green** on the refactored files. D2 lands after D1, so the status markers it adds must survive the de-verbosing.
- **E8 and D1 content survives the collapse.** The operative-rule inventory (above) explicitly enumerates and re-asserts **E8's renegotiation-loop steps** (independent-review spawn, the two-guard finding-validation, the canonical-file re-lock, the `failed-evaluation-rejected` path) and **D1's `[shipped-in-v1.0]` / `[partial-v1.0]` / `[deferred-to-v1.1]` status markers**. A silent drop of an E8 rule or a D1 marker during the hygiene collapse is the precise risk this AC guards — D2 refactors the *post-E8, post-D1* SKILL.md, and "behaviour-preserving" must include their additions.

### Manual review checks

- A reviewer diffs old vs new and confirms every removed line is ceremony (rationale, self-quote, duplicate, or a de-cited-but-inlined fact), never an operative instruction.

### Deferred-by-design

- None. D2 is self-contained within v1.0.

## Dependencies

- **E1** — the prompt set and `SKILL.md` D2 refactors (product artifacts, editable; the shipped E1 spec is cross-referenced, not edited).
- **R4** — the maintainer-tooling lint/build harness the new `lint-no-spec-ref` and the house-rules parity check join.
- **E8 (hard) and D1 (hard).** E8 rewrites the evaluator/proposer/reviewer prompts and adds the orchestrator renegotiation loop; D1 adds `SKILL.md` status markers. D2 refactors the **resulting** v1.0 prompt set, so it lands **after** both — not a soft preference: refactoring before them would refactor text those specs replace and risk silently dropping an E8 rule during a "behaviour-preserving" pass.

## Bite-size note

~1–2 sprints, sliced:

1. `SKILL.md` de-verbose + halt-contract collapse (with the five-distinction checklist) + self-quote removal.
2. `agents/_house-rules.md` extraction + per-agent inlining + the R4 parity check.
3. Reference classification + inlining of behaviour-bearing facts + `lint-no-spec-ref` + the strip.

Lands after E8 and D1 in the v1.0 order.
