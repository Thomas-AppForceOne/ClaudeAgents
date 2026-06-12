# E11 — Agent tool-grant & caller coherence

## Problem

Three coherence defects let the framework injure itself — its own prompts mandate calls the harness cannot grant, two prose homes disagree about who makes a load-bearing call, and a stack file mislabels its commands. Each one manufactures first-sprint blockers out of thin air (see [`_audit-2026-06-12-structural.md`](_audit-2026-06-12-structural.md) findings 5 and 8):

1. **Ungrantable mandates.** `agents/gan-evaluator.md` frontmatter declares `tools: Bash, Glob, Grep, Read, Write` while its body says it "MUST call the framework's `buildEvaluatorPlan` tool … named verbatim". A subagent whose frontmatter `tools:` list omits an MCP tool cannot call it. `agents/gan-generator.md:56` papers over the same gap for the docker tools with the claim "you do not need to widen the `tools` field in your frontmatter to call them" — an assertion nothing enforces or tests, and which is false under the harness's frontmatter-allowlist semantics. E9's proposer pre-flight (`validateCriterionReferences`) adds a third instance the day it lands.
2. **Caller ambiguity.** `skills/gan/SKILL.md` ("Evaluator forced-plan derivation") says the **orchestrator** calls `buildEvaluatorPlan` before the evaluator runs; `agents/gan-evaluator.md` says the **evaluator** must call it itself. Two prose homes assert different callers for the same mandatory call — the LLM resolves the contradiction differently per run.
3. **Mislabelled stack commands.** `stacks/web-node.md` declares `lintCmd: vitest run` — the test runner (BR-014). The evaluator's plan runs the suite twice and reports test failures as lint failures; with E8's blocker-auto-fail, a flaky test can fail a "lint" criterion.

The independent reviewer reproduced instance 1 as a real `blocker` finding in run `…1bdd`'s sprint 1 — the framework's own incoherence becomes an unresolvable finding that drives renegotiation and burns the cap.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — fixes existing prompt/stack surfaces and extends the existing `house-rules` maintainer lint; no new runtime surface.
2. **Composable?** Yes — the grant lint guards every future agent-prompt edit (E9, E10, D3 all touch prompts).
3. **Owns durable structured state?** No — coherence rules over shipped artifacts.
4. **Fits existing lanes?** Yes — house-rules is the established home for agent-frontmatter validity checks.
5. **Stackable?** Partially — it is corrective, but the lint is a permanent backstop. (3.5/5: this is infrastructure-repair, justified by the active incident.)

## Proposed change

### 1. Single-caller ruling: the orchestrator derives, agents execute

Pinned here for every role: **MCP calls that produce *inputs* to an agent are made by the orchestrator; the agent receives the result as data in its spawn payload.** Concretely:

- `buildEvaluatorPlan` is called by the **orchestrator** (SKILL.md's existing stance wins); `agents/gan-evaluator.md` is rewritten to consume the plan it is handed and execute its commands via Bash — "MUST call … verbatim" becomes "MUST execute every command in the plan the orchestrator passes". No MCP grant needed.
- MCP calls that are part of an agent's **own work product** (the generator's docker port tools, the proposer's E9 pre-flight) remain agent-side, and their fully-qualified tool names (`mcp__claudeagents-config__<name>`) are **added to that agent's frontmatter `tools:` list**. The false no-widening claim in `gan-generator.md` is deleted.

The decision rule itself is recorded in the prompts' shared house-rules region commentary, so future specs don't re-litigate it per tool.

### 2. Grant lint (extends `scripts/house-rules/`)

The house-rules script gains a **tool-grant check**: for each `agents/*.md`, every MCP tool the body mandates (matches of `` `mcp__…` `` names and the documented "call the framework's `<name>` tool" phrasing against the `api-tools-v1` tool inventory) must appear in the frontmatter `tools:` list; conversely, frontmatter MCP entries that no body text uses are flagged (dead grants). Rides the existing `test-house-rules.yml` — no new CI workflow file.

### 3. `web-node` stack repair + lint-stacks rule

- `stacks/web-node.md` `lintCmd` becomes `npm run lint` (the conventional script-presence form; its existing `absenceSignal`/`absenceMessage` path covers repos without a lint script, per the evaluator's shipped absence handling).
- `scripts/lint-stacks/` gains a rule: a stack where `lintCmd === testCmd`, or where `lintCmd` invokes a known test-runner binary (`vitest`, `jest`, `mocha`, `pytest`, `node --test`), fails the lint. (Delta-style, repo-keyed exceptions deliberately not provided — a stack that genuinely lints with its test runner forks at project tier.)

## Schema additions

None. Frontmatter, prompt prose, one stack file, and two maintainer scripts. No bundled schema or MCP tool changes.

## Acceptance criteria

1. **Caller unambiguous.** `grep -n 'buildEvaluatorPlan' agents/gan-evaluator.md skills/gan/SKILL.md` shows exactly one caller (the orchestrator); the evaluator prompt contains no instruction to call it and instead documents plan-as-input.
2. **Grants match mandates.** The house-rules grant check exits 0 on the repo; seeded fixtures prove it fails on (a) a body-mandated MCP tool missing from frontmatter and (b) a dead frontmatter grant.
3. **False claim retired.** `grep -c 'do not need to widen' agents/gan-generator.md` returns 0; the generator's frontmatter lists the docker tool names its body mandates.
4. **Proposer pre-flight grantable.** Post-E9-merge, `agents/gan-contract-proposer.md` frontmatter carries the pre-flight tool name and the grant check passes (coordination AC — verified at whichever of E9/E11 lands second).
5. **Stack repair.** `stacks/web-node.md` `lintCmd` is `npm run lint`; `npm run lint-stacks` exits 0, and a fixture stack with `lintCmd: vitest run` fails the new rule.
6. **Lints green.** `house-rules`, `lint-no-stack-leak` (the test-runner-binary list lives in the lint script, an allowlisted maintainer path, not in agent prompts), `lint-no-spec-ref`, `lint-error-text` all exit 0.

## Version bump: minor

`stacks/web-node.md` ships in the installed package (`files: ["stacks", …]`), so the PR minor-bumps `package.json`. Prompt edits alone would not bump; the stack change forces it.

## Dependencies

- **E9** (draft, in flight) — adds the proposer-side MCP mandate this spec makes grantable; either order works, with AC 4 verified at the second landing.
- **E8 / M4 / R7** (shipped) — the prompts and tools whose surfaces are being reconciled; cross-referenced, never edited.
- **D2** (shipped) — house-rules region discipline; the grant check is additive to that script.

## Bite-size note

One PR, one sprint: prompt rewrites (evaluator, generator, proposer frontmatter), the house-rules grant check + fixtures, the stack `lintCmd` repair + lint-stacks rule. Retirement rows (`M`) for the three rewritten prompts and the stack file land at merge.
