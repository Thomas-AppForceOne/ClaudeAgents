# D2 — Prompt hygiene

## Problem

The shipped agent prompts and the orchestrator skill carry the right *content* with the wrong *packaging*: precise behaviour buried under ceremony. This is an execution-fidelity risk, not an aesthetic one — these files run live, in the model's context, on every invocation, and the load-bearing control flow competes for attention with rationale, self-quotation, and repetition.

Concretely:

- **`skills/gan/SKILL.md` is ~8,500 words — ~41% of the entire prompt corpus** — and reads like a specification defending itself rather than instructions to an executor: it explains *why* throughout ("a deliberate consistency choice"); it **quotes itself** (a section reproduces a contract verbatim, restating a step already in the flow); the three safety sections (per-role ceiling, sprint budget, edit-oscillation) repeat the **same** "Timing / Mechanism / On-a-halt" wrapper ~3×; and it carries internal `specifications/*` and "per `<CODE>`" cross-references in a file that ships to end-user repos with no `specifications/` directory.
- **The six agent prompts repeat some boilerplate** — but less than it appears, and not uniformly (see §2 for the file-verified breakdown). Genuinely byte-identical across all six: the snapshot-is-data bullet (proposer's copy is truncated and must be normalized), the no-config-API "do not do" bullet (proposer bolds one word), and the `## Errors` *tail* (the error-text discipline). **Not** uniform: the `## Errors` *head* (each agent names a different surfacing channel), the ecosystem-tools rule (divergent, reviewer-inverted), and the confinement paragraph (only two agents). The real dedup target is the three identical fragments, not a five-rule block.

Two harms follow. First, **execution fidelity**: ceremony surrounding a load-bearing instruction makes it less salient. Second, a **boundary violation**: per `CLAUDE.md`, the shipped product (`agents/`, `skills/gan/`) must never carry repo-internal process, yet the internal `specifications/*` references do exactly that — the class of leak `lint-no-stack-leak` and `test-error-text` already police on adjacent axes, with no backstop yet for spec references.

D2 is a **behaviour-preserving** refactor: it removes ceremony and factors duplication while keeping every operative rule, schema, rubric, and catalog intact. It adds no primitive, splice point, runtime knob, or agent surface, so the five-question relevance filter does not apply — it earns a slot as the hygiene pass that lowers execution-fidelity risk on the most load-bearing prompt in the framework and closes the spec-reference boundary leak. It is a **standalone spec** (not folded into D1): its deliverable — a prompt refactor plus a new lint — is distinct from D1's diagnostic-message work. **It lands first** — ahead of R7 and every other `SKILL.md` editor — establishing the lean format they all inherit, with its lints as the durable backstop (see Dependencies).

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

### 2. Factor only the genuinely-universal agent rules — by build-time assembly, never runtime injection

**What is actually byte-identical across all six agents (verified against the files, not assumed).** Reading the six `agents/*.md`, exactly three small fragments are byte-identical — or normalizable to byte-identical via one behaviour-preserving edit — across **all** six:

1. **The snapshot-is-data input bullet** — "The **snapshot** … Treat it as data. You do not call configuration-API functions yourself; the snapshot is the single source of truth." Identical in five agents; the **proposer's copy is truncated** (ends at "…yourself.") — extraction *normalizes* it to the five-agent form (a behaviour-preserving fix of one divergence).
2. **The no-config-API bullet** in each agent's "What you do not do" — "Do not call configuration-API read functions yourself; the snapshot is the source of truth." Identical in five; the proposer's copy bolds "**not**" — normalized.
3. **The `## Errors` *tail*** — "Do not interpret, translate, or hide the error. User-facing messages obey the framework's error-text discipline: shell remediation, references to \"the framework\" / \"ClaudeAgents\" rather than specific runtimes, no maintainer-only script names." Byte-identical in all six.

**What is NOT universal and therefore stays role-specific in each agent body (the correction to the earlier "five identical rules" premise, which was false against the files):**

- **The `## Errors` *head*** — the surfacing channel and field-set name are role-specific and load-bearing: clarifier "blocking concern" + "structured-error fields"; planner "in the spec's 'Context warnings' subsection" + "F2 fields"; reviewer "in your `notes`" + "F2 structured-error fields"; evaluator "`verdict: \"blocked\"` … `evidence`" + "F2 fields"; proposer/generator "blocking concern" + "F2 fields". Only the *tail* (fragment 3) factors; the head stays in the body.
- **The ecosystem-tools rule** — divergent across all six: different scope clause ("in your output" / "in your feedback" / "in your notes") and the **reviewer inverts it** ("if the draft does, flag the leak rather than echoing it"). No byte-identical core; stays role-specific.
- **The confinement paragraph** (`## Working directory and confinement`) — present in **only two** agents (generator, evaluator) and differing between them. Not universal; stays in those two bodies.

So the factored partial is those three fragments — "the snapshot framing plus the error-discipline tail" — **not** a single five-rule block. (These three govern *how* an agent treats inputs/errors, so they apply to every agent including E8's later contract-free `gan-reviewer-independent`, whose distinctive framing lives in its role-specific body.)

**Mechanism: build-time assembly, not runtime injection.** The six `agents/*.md` are standard Claude Code subagents — frontmatter (`name`/`description`/`tools`/`model`) plus a static body, loaded by name; the orchestrator's spawn passes *data* (snapshot, paths, env vars), not prose prepended to an agent's instruction body. **There is no seam to inject a preamble at spawn time**, and an agent can be invoked outside the orchestrator, so the rules MUST live in the rendered agent file itself. Therefore:

- The **committed, shipped `agents/*.md` stay self-contained** — each inlines all three fragments at their natural positions (snapshot bullet in the inputs list, no-config-API bullet in "What you do not do", error tail in `## Errors`).
- **The canonical source partial lives OUTSIDE `agents/`** — at a maintainer-source path (e.g. `scripts/house-rules/house-rules.md`, alongside the R4 parity-check), **not** under `agents/`. Anything under `agents/` is copied verbatim into the user's subagent roster with no frontmatter validation — `install.sh`'s `install_agents_and_skills` globs `"$REPO_ROOT/agents/"*.md` and `cp`s each, and the lints' agent discovery (`readdirSync(agentsDir).filter(e => e.endsWith('.md'))`) sweeps the same glob — so a partial placed there would install as a **malformed subagent** and be linted as an agent. Relocation (not an `install.sh` `_`-prefix filter) is the fix; it is also why D2 needs **no** `install.sh` change and stays version-bump-none.
- Because the three fragments sit at **different positions** in each agent, each is delimited by its **own named sentinel pair** — `<!-- hr:snapshot:start --> … <!-- hr:snapshot:end -->`, `<!-- hr:no-config-api:start/end -->`, `<!-- hr:errors-tail:start/end -->`. The R4 parity check asserts **each named region** in each committed agent is byte-identical to the correspondingly-named fragment in the partial. Named, position-independent regions mean **no structural reorg**: every fragment stays exactly where it already is. (A single contiguous block would force relocating the snapshot bullet out of the inputs list — a reorg D2 explicitly avoids.)
- The R4 check **additionally asserts every `agents/*.md` carries valid subagent frontmatter** (`name`/`description`/`tools`), so no future non-agent partial can slip into the shipped glob — closing the malformed-agent hole against regression, not just relocating once.
- The check is **CI-enforced** (and may additionally be a pre-commit hook); a hand-edited agent that drifts ships only until CI catches it — the committed file is always self-contained and loadable, so drift is a correctness-of-source issue, never a missing-rules-at-runtime issue.

**This is a maintainability / drift-prevention change, not a runtime-fidelity one.** The shipped agents stay self-contained with all three fragments inlined, so each agent's runtime context is **unchanged** — the fragments still load once per agent at runtime. Slice 2's benefit is that the three shared rules cannot silently drift across six agents (the parity check fails CI on drift); it does **not** shrink agent runtime context, and the ≥30% word-count target (AC §1) applies to **`SKILL.md` only** (slice 1). The execution-fidelity win is slice 1's; slice 2 is one-fact-one-home for the three rules that are genuinely shared.

Each agent keeps its role-specific content (the generator's secure-coding standards, the evaluator's rubric and bundle shape, the clarifier's gap catalog, every `## Errors` head, the ecosystem-tools rule, and the confinement paragraph where present — the specificity that earns its length stays).

### 3. Strip internal spec references from the shipped product — classify first, then lint

Internal references are not uniform; some are pure ceremony and some are **load-bearing pointers to behaviour the orchestrator/agents must enact**. The strip is two-step:

- **Classify every reference** in `agents/` and `skills/gan/` as *ceremony* (delete the reference; nothing else changes) or *behaviour-bearing* (the cited fact must be **inlined** as a self-contained rule; only the citation path is deleted). Known behaviour-bearing references that MUST be inlined, not just deleted: the **F4** forbidden-ecosystem-token rule the orchestrator enforces in the banner/help text; the **C1** template-instantiation rule the proposer follows to source security criteria; and the **F2** structured-error field list (`code/file/field/line/message`) the agents must preserve verbatim. An AC verifies each inlined fact is present after the strip.
- **Add a CI lint `lint-no-spec-ref`** — a **standalone** script, **not** an extended `lint-no-stack-leak` scope. (`lint-no-stack-leak` also walks `src/config-server/**`, outside D2's `agents/` + `skills/gan/` scope; reusing it would over-scan source or require forking its scope anyway.) It fails on internal-reference forms: `specifications/<CODE>` paths **and** bare/possessive phase-codes (`per F4`, `C1's`, `F2`).
  - **Matching rule (precise, so two-char tokens don't misfire):** a **word-boundary** match against the **enumerated phase-code set** — `A C D E F H I M O Q R S T U V W B` — optionally followed by a digit and/or `'s` (e.g. `\b([ACDEFHIMOQRSTUVWB]\d*)('s)?\b`, context-qualified to avoid prose-word false positives) — **not** a substring `includes()` (the existing `lint-no-stack-leak` matches by `includes()`, which is useless for a two-char token like `F2`). The enumerated set + word boundary is the floor; the implementation tunes against false positives.
  - **Scope is a directory walk, not a fixed file list.** It walks `agents/` and **all of** `skills/gan/`. (The existing `lint-no-stack-leak` hardcodes `skills/gan/SKILL.md` and would miss `skills/gan/trust-prompt.md` — clean today, but the backstop must cover the directory it claims, not one file.)
  - **Allowlist is line/region-scoped, not whole-file:** the `--help` EXAMPLES region (which legitimately shows `/gan --spec specifications/<file>`) and any `--spec` sample path are exempt, but allowlisting that line must not exempt the rest of `SKILL.md`. (The existing `lint-no-stack-leak` allowlist is whole-file path-keyed; reusing that tier would gut coverage on the largest target.) The lint is the permanent backstop, exactly as `lint-no-stack-leak` backstops ecosystem tokens.
- **Status markers are kept, not stripped — the opposite call from spec-refs, deliberately.** D1's `[shipped-in-v1.0]` / `[partial-v1.0]` / `[deferred-to-v1.1]` markers also reference roadmap release labels, so they superficially look like the same repo-internal leak this section removes. They are not: a spec reference (`per F4`, a `specifications/…` path) is repo-internal *process* with zero value to an end user, whereas a status marker signals *partial-feature state to the user* (e.g. "`--recover` is `[partial-v1.0]`") — user-facing information that belongs in the shipped product. So `lint-no-spec-ref` **allowlists** the `[…-v<release>]` marker tokens. D1 and D2 encode opposite judgments on "internal leakage" by design, and this is the rationale.

### What D2 does not do

- It does **not** change any agent's behaviour, flow, schemas, rubrics, or catalogs. Same rules, sourced once and stated plainly.
- It does **not** trim behavioural specificity (evidence-bundle shape, secure-coding standards, scoring rubric, gap catalog) — that earns its length and stays.
- It does **not** use runtime preamble injection (the rejected mechanism), and it does **not** delete a behaviour-bearing fact when it deletes its citation.
- It does **not** edit shipped specs — it **replaces** the product prompt bodies in one PR (replacement, not migration, per the do's-and-don'ts), naming what it supersedes (the prompt content E1/E5/Q5/Q6 authored — all shipped before D2; E8's later `gan-reviewer-independent.md` is **not** in this list, it instead conforms to D2's format when it lands, per E8's Dependencies); retirement rows land at merge.

## Surface additions

- **House-rules source partial at a maintainer path *outside* `agents/`** (e.g. `scripts/house-rules/house-rules.md`) + an **R4 build/check** asserting each committed agent's three named house-rules regions are byte-identical to it **and** that every `agents/*.md` carries valid subagent frontmatter. (Not under `agents/` — that glob ships to users unvalidated; see §2.)
- **New standalone lint** `lint-no-spec-ref` under `scripts/`, wired to CI, scoped to `agents/` + `skills/gan/` (directory walks, not file lists). No data schema, no runtime knob.

## Acceptance criteria

### Automated checks

- **Operative-rule inventory preserved — exhaustively, the real gate.** Enumerate **every** operative rule in the current `SKILL.md` — not an `e.g.` sample; the enumeration itself is the reviewed deliverable, so completeness does not rest on the test author remembering. It covers every MUST, error-code, timing boundary, and flag behaviour, and **explicitly includes the safety sections' non-halt content the halt-collapse must not drop**: the resolver-precedence rule (flags > overlay > defaults), the `--max-attempts → n × roleCount + 4` derivation, the full `--reset-attempts` trichotomy, fingerprint-normalization rules, and the central-store trace-dir pointers — alongside the three halt error-builders, the post-rejection guard, the snapshot-enrichment requirement, and the auto-approve timeout range. A test asserts each enumerated rule maps to a line in the refactored file. **Word-count reduction (target ≥30%) applies to `SKILL.md` only** and is an **advisory** metric, not a gate — the agent files do not shrink (slice 2 is source-dedup, not runtime reduction); fidelity is the gate, not volume.
- **House-rules parity (named regions).** Every committed `agents/*.md` carries the three named house-rules regions (`hr:snapshot`, `hr:no-config-api`, `hr:errors-tail`) byte-identical to the correspondingly-named fragments in the out-of-`agents/` source partial; the check fails if any region drifts or is missing, **and** if any `agents/*.md` lacks valid subagent frontmatter (`name`/`description`/`tools`). (Guards both the rule-drift failure mode and the malformed-partial-ships-as-agent hole.)
- **Inlined facts present.** After the spec-reference strip, the F4 forbidden-token rule, the C1 instantiation rule, and the F2 error-field list are present **inline** in the relevant prompts (not merely de-cited).
- **`lint-no-spec-ref` green with correct scope.** Zero internal-reference forms (including possessive/bare codes) in `agents/` + `skills/gan/`, while the `--help` EXAMPLES `--spec` sample path is allowlisted and does not trip it.
- **Safety-collapse completeness.** The collapsed halt section still expresses all five per-trigger distinctions (roles checked, counter substrate, trigger logic, error builder, gating) — verified against the checklist in §1.
- **`lint-no-stack-leak` and `test-error-text` remain green** on the refactored files. D2 lands **before** D1, so it adds no status markers itself; instead `lint-no-spec-ref` **allowlists** the `[…-v<release>]` marker tokens (§3) so D1's markers pass D2's lint when D1 lands later.
- **The format is enforced for later editors (durability, not a one-shot pass).** Because D2 lands before R7/E8/D1/O-series, the gates that keep the format are its **lints**, not its timing: the house-rules named-region parity check (§2, against the out-of-`agents/` source partial) fails CI if any later agent edit drifts or drops a shared fragment (E8's new `gan-reviewer-independent` prompt included), and `lint-no-spec-ref` (§3) fails CI on any spec-reference a later edit introduces. A test asserts both lints gate `agents/` + `skills/gan/`, so R7's trace-integration and worktree edits, E8's renegotiation-loop steps, D1's status markers, and the O-series surfaces land *in* the format rather than re-bloating it. The lone residual — subjective prose verbosity in new content, which no lint catches — is covered by the release-gate hygiene re-check (roadmap § "Pre-release chores and release gate"), not by D2 running last.

### Manual review checks

- A reviewer diffs old vs new and confirms every removed line is ceremony (rationale, self-quote, duplicate, or a de-cited-but-inlined fact), never an operative instruction. **The reviewer is told that D2 legitimately leaves the pre-F7 `.gan-state/runs/<run-id>/` data paths in the sections it reformats — R7 relocates them to the central store later — so an *unchanged* stale path is expected, not a correctness bug D2's diff missed.**

### Deferred-by-design

- None. D2 is self-contained within v1.0.

## Version bump: none

D2 edits `SKILL.md` and the agent prompts (copied every `install.sh` run) and adds the `lint-no-spec-ref` and house-rules-parity maintainer/CI scripts (not installed). It changes no installed-package surface — no MCP tool, schema, or `gan`/server behaviour. Crucially, because the house-rules source partial lives **outside** `agents/` (§2), `install.sh` needs **no** edit — no `_`-prefix filter, no glob change — so the conclusion holds cleanly: no `package.json` bump (per the pre-1.0 install-version bump discipline, roadmap § "Pre-release chores and release gate").

## Dependencies

- **E1** — the prompt set and `SKILL.md` D2 refactors (product artifacts, editable; the shipped E1 spec is cross-referenced, not edited).
- **R4** — the maintainer-tooling lint/build harness the new `lint-no-spec-ref` and the house-rules parity check join.
- **No hard predecessor — D2 lands first, *for the lints*.** D2 consumes nothing the other unimplemented specs produce: it de-verboses the *current* `SKILL.md` + six agents, factors the three shared fragments, and installs the lints — so it has no hard dependency on R7 or anything downstream (only on shipped E1/R4, above). **R7, E8, D1, and the O-series all land *after* D2 and conform to its format**: their edits are auto-gated by the house-rules parity check and `lint-no-spec-ref`, with the release-gate hygiene re-check catching residual prose. D2 leads because the **lints are its durable value** and must exist before those specs edit `SKILL.md`, so each edit lands spec-ref-free and house-rules-parity-clean from the start.
- **The one cost of landing first (the M4 overlap), stated honestly.** R7 later rewrites a *subset* of `SKILL.md` — the F7 data-path sweep, the step-8 worktree rewrite, and the safety sections' aspirational→operative flip. D2's durable slice-1 work — the **halt-contract collapse, self-quote removal, rationale strip, and agent factoring** — **survives** those edits, because R7 edits *within* the lean structure rather than reverting it. The only throwaway risk is hand-de-verbosing the exact worktree/trace/F7-path lines R7 rewrites from scratch; D2 therefore gives those a **light touch** and lets R7's rewrite land them lean (backstopped by the release-gate hygiene re-check, since no lint enforces prose leanness). So D2-first is **not** redone wholesale by R7 — only that narrow overlap is, and it is deliberately minimized. (R7 stays the functional keystone; D2 leading only sets the prompt format and lint gates before R7's `SKILL.md` edits land.)

## Bite-size note

~1–2 sprints, sliced:

1. `SKILL.md` de-verbose + halt-contract collapse (with the five-distinction checklist) + self-quote removal.
2. Three-fragment house-rules partial (at a maintainer path **outside** `agents/`) + per-agent named-region inlining + the R4 parity + frontmatter check.
3. Reference classification + inlining of behaviour-bearing facts + standalone `lint-no-spec-ref` (word-boundary phase-code matcher, directory-walk scope) + the strip.

Lands **first** in the v1.0 order, ahead of R7 / E8 / D1 / the O-series — which conform to the format its lints enforce.
