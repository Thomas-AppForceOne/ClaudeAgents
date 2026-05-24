# Q6 — Doc-lint backing, presence gate, and comment-provenance

## Problem

[Q5](Q5-documentation-quality-enforcement.md) made documentation a measurable, stack-sourced,
gating concern with a sound three-layer model, but shipped *mechanism without implementation* in
two places, and the enforcement it does define runs only inside `/gan`. v1.0 dogfooding exposed all
three.

1. **`docLintCmd` is declared but unbacked.** Q5 defined it as the deterministic layer and
   deliberately deferred the reference tool ("tuned at implementation time"). `stacks/web-node.md:184`
   declares `docLintCmd: { command: "npm run doc-lint", … }`, but no tool ships — so the field
   resolves to Q5's graceful-absence path, the mechanizable rules are verified by nobody, and every
   `web-node` project eats an absence warning. Q6 delivers the deferred tool.
2. **Comments may narrate their development history.** Q5's `comments_explain_why_not_what` forbids
   restating the code, not recording *which spec/sprint/ticket/PR the code came from*. That
   provenance passes the why-not-what rule yet is meaningless outside the producing repo. The
   framework's own work shipped it, a human scrubbed it by hand, and the scrub still missed cases:
   a comment-scoped scan of `src/**/*.ts` finds **12 surviving in-comment phase-code tokens** —
   `F2`×7, `R5`×4, `M1`×1 (e.g. `config-server/index.ts:112`, `modules-list.ts:28`). (A handful more
   ride user-facing error strings — `'Per C2, …'` at `user-tier-forbidden.ts:53` — which Part C's
   surface covers: it judges comments and user-facing strings alike.)
3. **Enforcement is `/gan`-only.** Q5's layers run only in an evaluator pass; a direct human commit
   — the path that *produced* gap 2 — meets no documentation gate. The framework's CI runs no doc
   check.

Q6 resolves each of the three to exactly one of: **enforced now**, **mechanism defined with a named
trigger**, or **out with a stated technical reason**. It introduces no unnamed follow-up spec.

**Five-question relevance filter** (per [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) § Conventions),
applied to the single primitive Q6 extends — **Q5's web-node documentation enforcement**, completed:
(1) plugs into Q5's `docLintCmd`/`documentationSurfaces` and E3's invocation path — no new field;
(2) composable via Q5's overlay/stack-fork mechanisms; (3) findings/verdicts flow into the existing
evidence bundle + trace; (4) the tool joins the R4 lint family, the CI gate the existing per-check
workflow pattern; (5) per-stack `scope`, stackable. Builds on shipped **Q5/C1/E3/R4** (immutable,
cross-referenced, not edited).

## Part A — the deterministic doc-lint tool (resolves gap 1)

Ship `scripts/doc-lint/` (a framework TypeScript doc linter), wired as the `doc-lint` npm script,
backing `web-node`'s declared `docLintCmd` and serving as the reference command other ecosystems
model their own on. **Baseline-relative**: Q5 ships the `delta`/`absolute` mode but names no base-ref
field; the tool resolves the concrete ref itself — the **merge-base with the repo's base branch** —
and asserts no new evaluator-core field. A finding fails only when the diff *introduces* it. **Q6
ratchets; it does not retroactively clean** (existing findings are grandfathered; removing them is a
separate non-delta task).

Rules:

| Rule | Sound to gate? | Disposition |
|---|---|---|
| **Export-doc presence** — every introduced/changed export carries a doc comment | **yes — binary, no FP** | **blocker** (Part B gates it in CI too) |
| **Required-sections** — a function's doc documents its params/returns | no — parser FP surface (destructured/rest params, overloads, re-exports, prose-vs-`@param`) | **advisory**, promotable (Part D) |
| **Commented-out-code** | no — FP surface (`@example`, prose quoting code, URLs) | **advisory**, promotable (Part D) |
| ~~Type-loosening "without a cited rationale"~~ | **no sound test exists** | **dropped — see "Out of scope"** |

Only export-doc *presence* is binary, so it is the lone rule with no FP risk; the heuristics ship
advisory with their FP caveat in the finding text. This is not a tuning excuse — it is that one rule
is decidable and the others are not until measured (Part D).

## Part B — the CI presence gate (resolves gap 3, for the sound rule)

A new `.github/workflows/test-doc-lint.yml` runs `npm run doc-lint` over the PR diff on every push to
`main`/`develop` and every pull request — the established repo pattern (one `test-*` workflow per
maintainer-script repo-source gate, alongside `test-no-stack-leak` etc.). It **gates (blocker) on
export-doc presence only**; the heuristic rules run in the same invocation at **advisory** (reported,
non-blocking). This closes gap 3 for the one rule that can soundly gate a hand-written commit:
presence is binary, so gating it on every PR blocks no legitimate work — it blocks exactly a newly
undocumented export, which is the standard. Heuristics do **not** gate in CI (that would be the
"gate an unproven linter and block legit work on false positives" mistake); they gate only if and
when Part D promotes them.

**This requires growing the locked CI workflow inventory** (`PROJECT_CONTEXT.md:86`, `:90`) by one —
an 8th workflow. Q6 accepts that and commits to it: per the single-writer rule, **spec-validator
makes the coordinated `PROJECT_CONTEXT.md` § Testing edit** adding `test-doc-lint` to the inventory
at implementation. This is named and assigned, not dodged.

## Part C — the comment-provenance rule (resolves gap 2, soundly)

A new `documentationSurfaces` entry in `stacks/web-node.md` and `stacks/generic.md`, instantiated and
scored by Q5's existing evaluator path — language-neutral prose, stack data, no agent-prompt change:

```yaml
- id: comments_cite_no_development_provenance
  template: >
    Every comment, and every user-facing string the code emits (an error message, a log line,
    text shown to a user), added in this sprint explains the code's reasons — a constraint, an
    invariant, a non-obvious decision and its rationale — and references no development-process
    artifact: a specification or RFC identifier used as a process tag, a sprint or iteration
    label, a ticket, or a pull-request number. It says why the code is the way it is, not when,
    by which process, or under which plan it was written. A citation that is itself the rationale
    (an upstream bug the code works around, a standard the code implements) is allowed.
  triggers:
    scope: ["**/*.ts", "**/*.tsx"]
```

**Provenance enforcement is judgment, full stop — there is no sound deterministic gate for it.** A
regex cannot tell `// per our sprint-3 plan` (process noise) from `// implements RFC 7231 §6.5`
(rationale) from `// workaround for nodejs/node#1234` (rationale): they share token shapes, and the
distinction is intent. Phase codes are worse (`A1` the cell, `S3` the bucket). So provenance is the
LLM evaluator's job, scored in `/gan` over the `.ts`/`.tsx` diff — comments and user-facing strings
alike (the evaluator already reads string literals in the diff, and a stray `'Per C2'` in an error
message ships provenance to the end user, so it is in scope). This is the *complete* sound mechanism
for provenance available to this pipeline; its limits define what is out of scope below.

## Part D — promotion of the advisory rules (mechanism + named trigger)

The two advisory doc-lint rules (required-sections, commented-out-code) graduate to blocker through a
committed, date-able process, not "eventually":

- **Metric:** each rule's false-positive rate, judged from the advisory findings it produces across
  dogfooding runs (surfaced in run state by evaluator-core, like every other doc finding).
- **Trigger:** the **post-v1.x dogfooding audit** — the existing, scheduled roadmap convention
  (`roadmap.md` § "Post-v1.0 dogfooding audit": every candidate is re-audited against T1 trace data
  before the next release). Q6 requests spec-validator add these two rules to that audit's checklist.
- **Action / owner:** when the audit finds a rule's FP rate acceptable, a follow-up PR flips that
  rule's default severity in `scripts/doc-lint/` from advisory to blocker (and, if it is to gate
  hand-written commits, it is already in the Part B CI invocation — only its severity changes).
- **Threshold:** set by the audit against the observed FP distribution. It is **not** guessed now,
  because guessing it is the failure mode "prove-on-signal" exists to prevent — but the metric,
  trigger, owner, and action above are fixed contracts with a real event behind them.

## What gates, plainly (no overstatement)

On landing, three things gate:

- **export-doc presence** — deterministic; blocks inside `/gan` *and* on every PR (Part B);
- **`comments_cite_no_development_provenance`** — judgment; blocks inside `/gan` over the `.ts`/`.tsx`
  diff (comments and user-facing strings);
- (nothing else: required-sections and commented-out-code are advisory until Part D promotes them.)

Q6 does not claim to enforce the full documentation standard everywhere. It claims exactly the above.

## Out of scope, with reasons (not deferred to a phantom spec)

- **Provenance on direct, non-`/gan` commits (any file) — blocked on a missing capability.** A commit
  that never runs `/gan` is seen only by CI, where the sole sound provenance detector (LLM judgment)
  does not run and a deterministic scan is unsound (Part C: a regex blocks legitimate RFC/upstream-bug
  citations). Catching provenance here would require **an LLM evaluating the diff in CI — a capability
  this framework does not have.** A named blocker, not a tuning delay: buildable if and when an
  LLM-in-CI verification surface exists (a V-series concern), and not before.
- **Provenance in markdown (`agents/`/`skills/` and any `*.md`) — out by design, not by capability.**
  The judgment surface *could* cover markdown authored in a `/gan` sprint just by adding `**/*.md` to
  its `scope` — the evaluator already runs; this is a stack-data choice, not a machinery limit. Q6
  deliberately does **not**, in the built-in `web-node` stack: that stack ships to every web-node
  project, so `**/*.md` would impose provenance judgment on end-user READMEs, changelogs, and docs,
  flagging a user's legitimate reference to their *own* tickets in their *own* internal prose — the
  framework over-reaching into a user's documentation. (Contrast user-facing *strings*, which Part C
  *does* cover: those are product output the end user sees, where provenance is bad in any product.)
  The framework repo's own shipped agent prompts are a framework-repo concern, not a shipped-stack
  one: this repo can scope a **project-tier** `documentationSurface` to `agents/**/*.md` /
  `skills/**/*.md` to judge its own prose in its own `/gan` runs — an available config choice with
  existing capability, not new work and not a phantom spec.
- **Type-loosening enforcement.** Q5 named it, but "loosened *without a cited rationale*" has no
  sound deterministic test — "rationale" is judgment, and the only mechanical proxy ("any adjacent
  comment exists") is near-useless. Rather than ship a near-no-op that implies it has teeth, Q6 omits
  it. A sound version is a judgment surface (a future `documentationSurfaces` entry), not a doc-lint
  rule; it is out of Q6 and not promised to a follow-up.
- **Cross-language doc-lint.** `web-node` (TypeScript) is the only backed command; other ecosystems
  supply their own per Q5's stack-owns-the-command split.
- **Retroactive cleanup** of the 12 existing in-comment tokens (and the string-literal ones): the
  ratchet grandfathers them; removing them is a one-time non-delta task, not Q6's job.

## Surfaces

- A `doc-lint` npm script (`scripts/doc-lint/`), in the R4 lint family.
- A `test-doc-lint.yml` CI workflow (the 8th — with the coordinated `PROJECT_CONTEXT.md` § Testing
  edit assigned to spec-validator, Part B).
- One `documentationSurfaces` entry in `stacks/web-node.md` and `stacks/generic.md`.

No `/gan`/`gan` flag, env var, prompt branch, or schema field.

## Schema additions

None. Reuses Q5's `docLintCmd` and `documentationSurfaces`.

## Acceptance criteria

### Automated

- `npm run doc-lint` over the **merge-base delta** fails when the diff introduces an exported symbol
  with no doc comment (lone blocker); required-sections and commented-out-code emit **advisory**
  findings that do not, alone, exit non-zero. An empty change reports nothing; a fixture diff adding
  an undocumented export reports the blocker (the "clean" claim is delta-vs-merge-base, not a vacuous
  no-diff run nor an absolute full-tree scan).
- `test-doc-lint.yml` runs `npm run doc-lint` on `pull_request`; a PR introducing an undocumented
  export fails the check; a PR introducing only an advisory-rule finding does **not** fail it.
- Inside `/gan`, evaluator-core's `docLintInvocations` for `web-node` resolves to `npm run doc-lint`
  and runs it.
- The `comments_cite_no_development_provenance` entry validates against `schemas/stack-vN.json`;
  `lint-stacks` passes; a `/gan` sprint instantiates `web-node.comments_cite_no_development_provenance`
  verbatim and the evaluator scoring it below threshold fails the attempt.
- The tool's behaviour is covered by `tests/doc-lint/` fixtures riding `npm test`.

### Manual

- The provenance template names no repo-specific phase codes and explicitly permits a citation that
  *is* the rationale (RFC/upstream bug), so it reads correctly for an end-user repo and does not flag
  legitimate standard/upstream references.
- A comment **or user-facing string** naming a spec/sprint/ticket/PR as process scores below
  threshold (e.g. an error message `'Per C2, …'`); a genuine rationale, and a domain token that
  merely looks like a phase code (`S3` in code, a cell ref in a fixture), do not — demonstrating
  provenance is judgment. A markdown (`*.md`) provenance comment is **not** flagged by the built-in
  stack (out by design).
- `lint-no-stack-leak` stays green; the `doc-lint` command is the only ecosystem token, in its tool;
  doc-lint finding strings obey F4 discipline.
- The Part B CI gate blocks on presence only; the § Testing inventory edit is present (spec-validator).

## Dependencies

- **Q5** (shipped) — delivers its deferred `docLintCmd` tool and adds one `documentationSurfaces`
  entry; reuses its instantiation/scoring/severity machinery; not edited.
- **C1** (shipped) — schema + template-instantiation; reused.
- **E3** (shipped) — supplies the command its `docLintInvocations` runs; not edited.
- **E1/E2** (shipped) — already instantiate/score `documentationSurfaces`; no prompt change.
- **R4** (shipped) — `doc-lint` joins the lint family; CI follows the existing per-check workflow.

## Bite-size note

1. (one sprint) `scripts/doc-lint/` + diff/base-ref plumbing + export-doc **presence** (blocker) +
   `npm run doc-lint` + `tests/doc-lint/` fixtures riding `npm test`.
2. (one sprint) Required-sections + commented-out-code heuristics at **advisory** with FP-caveat
   finding text; wire into `/gan` via `docLintInvocations`.
3. (one sprint) `test-doc-lint.yml` gating presence on PRs (with spec-validator's § Testing inventory
   edit); the `comments_cite_no_development_provenance` `documentationSurfaces` entry in both built-in
   stacks + `lint-stacks`/instantiation tests + `lint-no-stack-leak` check.

Part D (advisory→blocker promotion) is a checklist item on the existing post-v1.x audit, not a sprint
here. There is no separate follow-up spec.

## Note for spec-validator

Q6 is slotted as the **`Next.`** item in the v1.0 implementation order (`roadmap.md`), pulled ahead
of the remaining v1.0 work per an explicit prioritisation call — not its original Q-series v1.2
placement. `PROJECT_CONTEXT.md` is untouched (single-writer). Remaining for spec-validator: add the
Dependencies cross-refs (Q5/C1/E3/E1-E2/R4) to the depended specs' roadmap entries; at
implementation, make the coordinated `PROJECT_CONTEXT.md` § Testing inventory edit for
`test-doc-lint.yml` (Part B); and add required-sections/commented-out-code to the post-v1.x
dogfooding-audit checklist (Part D).
