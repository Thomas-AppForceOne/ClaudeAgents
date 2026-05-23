# Q5 — Documentation-quality enforcement

## Problem

The framework's own ethos is that you cannot rely on a generating agent *following* a
style guide. Documentation is invisible work: a doc comment that is missing, or that
restates what the code already says, costs nothing at generation time and is the first
thing dropped under pressure. The framework already learned this for security — it stopped
*instructing* the proposer to "consider security" and instead made security a set of
measurable, stack-sourced contract criteria the evaluator scores ([C1](C1-stack-plugin-schema.md)
`securitySurfaces`, [E2](E2-builtin-stack-extraction.md)'s retirement of the hardcoded
checklist). Documentation has no equivalent: nothing in the shipped pipeline *verifies and
gates* documentation quality. [E3](E3-evaluator-pipeline-harness.md)'s "Hygiene-check
coverage" section names `lintCmd`, `securitySurfaces`, and `evaluator.additionalChecks` as
the hygiene surfaces and asserts hygiene criteria "carry weight comparable to functional
criteria" — but documentation, the most-dropped hygiene class, has no first-class surface
of its own. A project that wants generated code to document its public contracts has only
prose instruction to lean on, which is exactly the lever the framework's design says does
not hold.

Q5 closes that gap the way the security gap was closed: encode the documentation standard
as **verifiable, gating checks sourced from project configuration**, not as instruction
baked into agent prompts. Doc conventions vary by language and team, so the framework
declares **no** standard of its own in agent code; each active stack declares its standard
as data (with sensible built-in defaults), and the contract-proposer and evaluator
instantiate it through the *same* machinery they already use for `securitySurfaces`.

**Five-question relevance filter** (per [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md) §
Conventions). Q5 passes all five, so it is infrastructure, not a terminal feature:

1. **Plugs into existing primitives?** Yes. It adds two stack-schema fields and reuses C1's
   template-instantiation protocol verbatim, evaluator-core's command-running path (E3), the
   overlay suppress/extend splice points (C3), and the measurement-vs-gating severity model.
   It reaches around nothing — no agent-prompt-embedded standard, no new ownership lane.
2. **Composable?** Yes. Projects suppress, extend, or fork a stack's documentation standard
   through the existing overlay/stack-fork mechanisms without re-implementing any logic;
   every future stack declares its own standard the same way.
3. **Durable structured state?** Yes. The standard lives in committed stack/overlay
   configuration; instantiated criteria are scored into T1's evaluator evidence bundle and
   trace, keyed by criterion name like every other criterion.
4. **Fits existing boundaries?** Yes. Stack/overlay schema, per-stack `scope` filtering, the
   three-tier cascade, and schema-versioning rules all apply unchanged.
5. **Stackable?** Yes. In a polyglot repo each active stack contributes its own documentation
   surfaces over its own scope, composed through the active-set union exactly as
   `securitySurfaces` are (per [C2](C2-stack-detection-and-dispatch.md)'s scope-filtered rule).

**Release-deferred by design.** Per the "Release-driven from v1.0 forward" convention,
Q-series quality signal is deferred to the release whose dogfooding produces the data to
design it well. The *mechanism* in this spec (the two fields, the instantiation, the
evaluator-core check) is settled; the *shipped default standard* (which rules each built-in
stack ships, the exact template wording, which rules gate versus warn, thresholds) is tuned
at implementation time against v1.0/v1.1 T1 traces rather than guessed now. Q5 is slotted in
v1.2 (quality signal) alongside [Q1](roadmap.md); the roadmap entry is its order home.

Q5 builds on decisions that shipped in **C1** (the stack schema), **E1/E2** (the
contract-proposer and evaluator prompts and the security-surface sourcing they carry), and
**E3** (the evaluator deterministic core). Those specs are immutable; Q5 supersedes/extends
the relevant decisions through the new-spec mechanism, and the roadmap cross-references Q5
from their entries (per the "Implemented specs are immutable" convention). Artifacts the
implementation rewrites or retires are listed in `specifications/retirements.md` at merge
time, and new runtime surfaces in `specifications/runtime-knobs.md`, per those files' own
conventions (deferred to the implementation PR).

## Proposed change

Documentation quality is enforced in **three layers**, weakest to strongest, each sourced
from one config home so the standard cannot drift across them.

### Layer (a) — default convention (weakest, sets starting behaviour)

The built-in stacks (`stacks/web-node.md`, `stacks/generic.md`) ship a default
`documentationSurfaces` set and a default `docLintCmd` (defined below). This is the starting
bar a project gets with zero configuration. It is the weakest layer because a project can
mute it (`proposer.suppressSurfaces`), extend it (`proposer.additionalCriteria`,
`evaluator.additionalChecks`), or replace it wholesale by forking the stack file (per
[C5](C5-stack-file-resolution.md)). Crucially — per the `lint-no-stack-leak` boundary
([R4](R4-maintainer-tooling.md)) — the default lives in **stack data, never in agent
prompts**. The agent prompts carry no documentation standard, only the instruction to
instantiate whatever the active stacks declare.

### Layer (b) — deterministic doc-lint (strongest, cannot drift): `docLintCmd`

The mechanizable rules — *a documentation comment is present on every exported symbol; the
required doc-contract sections are present; no commented-out code is introduced; types are
not loosened* — are enforced by a deterministic command, not a judgment. A new **stack
field `docLintCmd`** carries it, modelled structurally on C1's `auditCmd` (so a stack
without a doc-lint tool degrades gracefully rather than producing a false failure):

```yaml
docLintCmd:
  command: "<ecosystem-specific doc-lint invocation>"   # required
  fallback: "<alternate invocation>"                     # optional
  absenceSignal: warning            # blockingConcern | warning | silent (mirrors auditCmd)
  absenceMessage: "No documentation linter is configured for this stack."
  severity: blocker                 # blocker | warning | advisory (gating policy, see below)
  baseline: delta                   # delta | absolute (default: delta)
```

The framework owns the **slot, the scoping, the absence handling, the baseline semantics, and
the gating policy**; the stack owns the **command** (ecosystem-specific, hence stack data).
Behaviour:

- **Stack-scoped.** evaluator-core runs `docLintCmd` only against files inside the owning
  stack's `scope`, exactly as it does `lintCmd`/`auditCmd`/`securitySurfaces` — no
  cross-contamination in a polyglot repo (per C2's scope-filtered rule).
- **Distinct from `lintCmd`.** `lintCmd` is the general code linter; `docLintCmd` is the
  documentation linter. They are separate fields for the same reason C1 split
  `build`/`test`/`lint`: failure signals stay distinct, and documentation findings are
  independently attributable, severable, and overridable.
- **Baseline-relative by default** (`baseline: delta`), per the "Integrity probes default to
  delta/ratchet semantics" convention. A pre-existing undocumented export in the run's base
  ref does not fail the run; only a regression introduced by the sprint's diff does. This is
  what makes the check usable on brownfield repos. `baseline: absolute` is available for
  greenfield or strict projects.
- **Absence-tolerant.** When the configured tool is missing on the host, evaluator-core
  surfaces `absenceMessage` as a warning and does **not** score the documentation criterion as
  failed for tool absence alone — identical to `auditCmd`'s `absenceSignal` handling.
- **Severity sets gating.** `severity` is the deterministic layer's home for the
  measurement-vs-gating split (below).

A project that needs *additional* deterministic doc checks beyond the stack default layers
them through the existing `evaluator.additionalChecks` overlay splice point (C3) — the same
escape hatch E3 names for hygiene extension — without touching the stack.

### Layer (c) — evaluator-scored gating criteria (judgment): `documentationSurfaces`

The judgment rules — *comments explain WHY, not WHAT; public contracts state each
parameter's meaning, failure modes, side effects, and invariants; non-obvious decisions cite
a rationale* — cannot be mechanized; they require the LLM evaluator. A new **stack field
`documentationSurfaces`** carries them as templated criteria, **structurally identical to
`securitySurfaces`** and instantiated through the *same* C1 template-instantiation protocol:

```yaml
documentationSurfaces:
  - id: public_contract_completeness
    template: >
      Every exported function, class, or type added or changed in this sprint documents,
      in its doc comment, each parameter's meaning (not merely its type), the failure modes
      it can raise, any side effect beyond its return value, and any invariant the caller
      must uphold.
    triggers:
      scope: ["**/*.ts", "**/*.tsx"]
      keywords: ["export function", "export class", "export const", "export interface"]
  - id: comments_explain_why_not_what
    template: >
      Every comment added in this sprint explains a constraint, an invariant, or a
      non-obvious decision and its rationale — not a restatement of what the adjacent code
      already expresses. No added comment can be deleted without losing information absent
      from the code itself.
    triggers:
      scope: ["**/*.ts", "**/*.tsx"]
  - id: nonobvious_decision_cites_rationale
    template: >
      Any non-obvious implementation decision in changed code (a workaround, a performance
      trade-off, an ordering constraint) cites its rationale in a comment or doc contract.
    triggers:
      scope: ["**/*.ts", "**/*.tsx"]
```

Behaviour — a faithful mirror of `securitySurfaces`, so the proposer gains a *parallel*
sourcing section, not a new algorithm:

- The contract-proposer applies C1's template-instantiation protocol per surface per sprint:
  intersect the sprint's affected files with the surface's `triggers.scope` and the stack's
  own `scope`; if non-empty and any `triggers.keywords` match the touched files, instantiate
  the `template` **verbatim** as a contract criterion (no interpolation; matched files and
  keywords recorded as *rationale*). A surface with neither trigger instantiates whenever the
  stack is active and the sprint touches any in-scope file.
- Criteria are keyed by `<stack-name>.<surface-id>` — the same fully-qualified cross-stack
  namespace `securitySurfaces` uses. The proposer never deduplicates by bare id.
- The LLM evaluator scores each instantiated criterion against its threshold and writes the
  verdict into T1's evidence bundle keyed by criterion name, exactly as for any criterion.

### Gating model (measurement is separate from gating)

Per the "Measurement is separate from gating" convention, every documentation finding carries
a severity and a gating policy; the LLM evaluator's PASS/FAIL on contract criteria remains the
**sole authoritative gate**. The two layers sit on opposite sides of that line, which is what
gives a project genuine per-rule control:

- **`documentationSurfaces` criteria GATE.** They *are* contract criteria, and a contract
  criterion's evaluator verdict is the gate — by the framework's core invariant. Encoding a
  judgment rule as a surface is therefore a deliberate "this must gate" decision. A project
  that wants a judgment rule measured but *not* enforced does not encode it as a surface; it
  monitors it through layer (b) at `warning`/`advisory` severity instead.
- **`docLintCmd` GATES or WARNS per its `severity`.** `blocker` fails the attempt; `warning`
  is recorded in run state and surfaced; `advisory` routes to the next generator attempt
  and/or spins a follow-up task but never blocks — the W1 non-aborting philosophy applied to
  generator output, exactly as the convention prescribes. This is the per-rule gates-or-warns
  knob the design calls for, and it lives on the deterministic layer because deterministic
  findings already fit the severity model (like the Q1/Q3 integrity probes).

This split, not a new advisory-contract-criterion channel, is the answer to "decide per rule
whether it gates or warns": the *channel a rule travels* (surface vs. doc-lint) and the
doc-lint `severity` together determine its gating, with the evaluator's contract verdict
preserved as the single gate. (A genuinely out-of-contract documentation finding has no home
in today's evidence bundle; that orphan-finding gap is **Q2**'s territory, per the roadmap,
and Q5 does not pre-empt it.)

### One home for the standard (no drift)

Every documentation rule lives in exactly one place: a judgment rule is one
`documentationSurfaces.template`; a mechanizable rule is enforced by the tool `docLintCmd`
invokes. Nothing is restated. The agent prompts **reference** the fields ("instantiate
documentation criteria from the active stacks' `documentationSurfaces`; run their
`docLintCmd`") and never carry the standard's prose — the same discipline that keeps
`securitySurfaces` out of the prompts. A restated standard is a stale standard; the
`lint-no-stack-leak` boundary plus a manual-review check (below) keep the prose single-homed.

### Project customisation through existing primitives (no new splice point)

Q5 adds **no** overlay splice point. The standard is customised through mechanisms C3 already
ships, generalised from security surfaces to documentation surfaces:

- **`proposer.suppressSurfaces`** mutes a documentation surface by its `<stack>.<surface-id>`
  key, dropping that criterion from the contract even though the stack is active — without
  forking the stack file. Documentation surface ids share the same `<stack>.<surface-id>`
  namespace as security surfaces, so the existing field applies unchanged. The surface-id
  existence check that C3 describes for suppression generalises to the **union** of a stack's
  `securitySurfaces ∪ documentationSurfaces` ids: suppressing an id that names neither warns
  (non-aborting), per C3's rule. (C3's suppress-warning channel is itself deferred to O1 and
  not yet a runtime guarantee, so this is a forward extension, not a contradiction of shipped
  behaviour.)
- **`proposer.additionalCriteria`** adds project-specific documentation criteria the proposer
  treats like any other.
- **`evaluator.additionalChecks`** adds project-specific deterministic doc checks beyond
  `docLintCmd`.
- **Forking the stack file** (C5) replaces the whole `documentationSurfaces` / `docLintCmd`
  set wholesale, for projects whose documentation standard diverges structurally from the
  built-in default.

### Agent-prompt changes (handled via the new-spec mechanism)

The shipped contract-proposer and evaluator prompts (E1/E2) gain a documentation clause that
*parallels by reference* their security clause — no embedded standard:

- **`agents/gan-contract-proposer.md`** gains a "Sourcing documentation criteria" section that
  applies the identical template-instantiation protocol to
  `snapshot.activeStacks[*].documentationSurfaces`. The "What you do not do" list extends to
  forbid restating any documentation standard in the prompt.
- **`agents/gan-evaluator.md`** gains `snapshot.activeStacks[*].docLintCmd` to its "What you
  read from the snapshot" list and consumes the evaluator-core plan's new doc-lint entries
  (below); the documentation criteria the proposer instantiated are scored through the
  existing per-criterion path, with no special-casing.

Both are shipped *implementation artifacts* (rewritten in place under their existing E1
contract), not shipped *specs*; Q5's implementation rewrites them and lands `M` rows in
`retirements.md`, exactly as F7 rewrote H1's confinement-hook template. `lint-no-stack-leak`
must stay green: the documentation standard is language-neutral prose, and the only
ecosystem-specific token (the `docLintCmd` command) lives in the owning stack file, where it
is allowed.

### Evaluator-core changes (extends E3's deterministic plan)

E3's deterministic core gains one new pure function and one new plan entry class, mirroring
`auditCommands`:

```json
"docLintInvocations": [
  {
    "stack": "web-node",
    "command": "<doc-lint invocation>",
    "scope": ["**/*.ts", "**/*.tsx"],
    "severity": "blocker",
    "baseline": "delta",
    "absenceSignal": "warning"
  }
]
```

The function is a pure mapping over (resolved snapshot, sprint plan, worktree state) — it
emits one entry per active stack that declares `docLintCmd`, scoped to that stack, and emits
none for a stack without the field. It satisfies E3's "new trigger types must be expressible
as a pure function over (file content, file path, sprint plan)" rule and stays inside the
deterministic core; the harness gains golden coverage for it via the bootstrap fixtures.
E3 is shipped; Q5 specifies the addition and the implementation extends `evaluator-core` and
the goldens — E3 is not edited (roadmap cross-reference).

### What Q5 does not do

- **Define a documentation standard in framework code.** The standard is stack data; the
  framework ships defaults in the built-in stacks and stays neutral. New ecosystems declare
  their own.
- **Add a new overlay splice point.** Customisation rides C3's existing
  `suppressSurfaces` / `additionalCriteria` / `additionalChecks` and C5 stack-forking.
- **Introduce an advisory *contract-criterion* channel.** Out-of-contract documentation
  findings remain Q2's concern; Q5's advisory tier lives on the deterministic `docLintCmd`
  layer only.
- **Verify rendered docs, prose tone, or subjective "quality".** Q5 enforces *measurable*
  documentation properties (presence, contract completeness, why-not-what, rationale
  citation). A graded subjective-quality rubric is the E7/Q-series v2.0 concern.
- **Replace `lintCmd`.** General linting stays where it is; `docLintCmd` is additive.

## Surfaces

No new `/gan` or `gan` CLI flag, no env var, no confinement-hook surface. The only runtime
surfaces are the two stack-schema fields (`documentationSurfaces`, `docLintCmd`) and the
already-existing overlay fields they make use of. Per the runtime-knobs convention, any
surface-count-relevant entries land in `specifications/runtime-knobs.md` in the implementation
PR; Q5 introduces no user-facing flag, so the inventory change is limited to noting the two
new stack fields if the inventory tracks schema fields.

## Schema additions

Two new **optional** fields on the stack schema (behaviour documented above; shapes listed
here per the "Schemas are the canonical inventory" convention). The implementation PR lands
them in `schemas/stack-vN.json`:

- `documentationSurfaces` — array of `{ id: string, template: string, triggers?: { scope?:
  string[], keywords?: string[] } }`. Default: `[]` (omitted = the stack contributes no
  documentation criteria). Structurally identical to `securitySurfaces`.
- `docLintCmd` — object `{ command: string, fallback?: string, absenceSignal:
  "blockingConcern" | "warning" | "silent", absenceMessage?: string, severity: "blocker" |
  "warning" | "advisory", baseline?: "delta" | "absolute" }`. `absenceMessage` required when
  `absenceSignal` ≠ `silent`; `baseline` defaults to `delta`. Default: omitted (the stack runs
  no deterministic doc-lint). Structurally modelled on `auditCmd`.

Both are additive optional fields. Per "Schema discipline tightens at v1.0 cut", an additive
change at/after v1.0 stays on the current `stack-vN`; the implementation PR (v1.2) confirms
and lands the version per F3's exact-match rules at that time. No overlay-schema change is
required — Q5 adds no overlay splice point.

## Examples

A `web-node` sprint that adds an exported function with no failure-mode documentation:

```
# sprint touches src/export.ts (in web-node.scope); web-node ships:
#   documentationSurfaces[public_contract_completeness] (keyword "export function" hits)
#   docLintCmd { severity: blocker, baseline: delta }
#
# contract gains criterion  web-node.public_contract_completeness  (template verbatim)
# evaluator-core plan gains  docLintInvocations[web-node]  scoped to web-node files
#
# the new export documents params + return but omits the thrown error it can raise
#   → evaluator scores web-node.public_contract_completeness below threshold → attempt FAILS (gates)
#   → doc-lint (delta): the export carries a doc comment, so the presence rule passes;
#     no pre-existing undocumented export is dragged in by the baseline
```

A project that wants the why-not-what rule measured but not blocking, on a one-real-stack
repo, suppresses the gating surface and adds a non-gating deterministic equivalent:

```yaml
# .claude/gan/project.md
proposer:
  suppressSurfaces:
    - web-node.comments_explain_why_not_what     # drop the gating judgment criterion
evaluator:
  additionalChecks:
    - command: "npm run comment-quality -- --warn-only"
      on_failure: warning                        # measured, surfaced, never blocks
```

A polyglot repo: each active stack contributes its own documentation surfaces over its own
scope; a `.py`-stack documentation surface is never instantiated against a `.ts` file, and
each stack's `docLintCmd` runs only over its own `scope` — the same isolation
`securitySurfaces` and `auditCmd` already have.

## Acceptance criteria

### Automated checks

- A sprint that touches a file inside a stack's `scope`, where that stack declares a
  `documentationSurfaces` entry whose `triggers` fire, produces a contract criterion keyed
  `<stack>.<id>` carrying the surface's `template` **verbatim**; a sprint that touches no
  in-scope file (or no keyword) for that surface produces no such criterion.
- Documentation surface ids share the `securitySurfaces` cross-stack namespace: two active
  stacks declaring the same documentation surface id yield two distinct criteria
  (`<stackA>.<id>` and `<stackB>.<id>`); the proposer never deduplicates by bare id.
- evaluator-core's plan lists one `docLintInvocations` entry per active stack that declares
  `docLintCmd`, scoped to that stack's `scope`, carrying its `severity`/`baseline`; a stack
  without `docLintCmd` produces none. The new core function is exercised by a golden in the
  E3 bootstrap fixture set (`js-ts-minimal/` and the synthetic guard-rail fixture).
- A stack declaring `docLintCmd` whose tool is absent on the host surfaces `absenceMessage` as
  a warning and does **not** score the documentation criterion as failed for tool absence
  alone (parity with `auditCmd`).
- With `baseline: delta`, a pre-existing undocumented exported symbol in the run's base ref
  does not fail the run; a new undocumented exported symbol introduced by the sprint's diff
  fails it when `severity: blocker`. With `baseline: absolute`, the pre-existing symbol also
  fails.
- A `documentationSurfaces` criterion the LLM evaluator scores below its threshold yields a
  failing attempt (proving layer (c) gates, not merely warns).
- A `docLintCmd` with `severity: warning` that finds a regression records the finding in run
  state and surfaces it without failing the attempt; with `severity: advisory` it routes to
  the next attempt / a follow-up task and never blocks; with `severity: blocker` it fails the
  attempt.
- `proposer.suppressSurfaces: ["<stack>.<doc-surface-id>"]` drops that documentation criterion
  from the contract while the stack is active; suppressing an id present in neither the
  stack's `securitySurfaces` nor its `documentationSurfaces` produces a non-aborting warning
  (per C3, gated on O1's warning channel).
- The default `documentationSurfaces` and `docLintCmd` shipped in `stacks/web-node.md` and
  `stacks/generic.md` validate against `schemas/stack-vN.json`; `node scripts/lint-stacks`
  passes.
- A stack-scoping regression test: a `documentationSurfaces` entry and a `docLintCmd` from one
  stack are never applied to files outside that stack's `scope` in the polyglot fixture
  (`polyglot-webnode-synthetic/`).

### Manual review checks

- The rewritten `agents/gan-contract-proposer.md` and `agents/gan-evaluator.md` contain **no
  restated documentation-standard prose** (the standard lives only in
  `documentationSurfaces` / `docLintCmd`) and **zero ecosystem-specific tokens** —
  `node scripts/lint-no-stack-leak` stays green; the doc-lint command in each built-in stack
  is the only ecosystem-specific token and lives in its owning stack file.
- The roadmap's Q5 entry names its supersession/extension of C1 (schema), E1/E2 (proposer +
  evaluator prompts), and E3 (evaluator-core); none of those shipped specs is edited.
- `retirements.md` gains `M` rows for the rewritten `agents/gan-contract-proposer.md` and
  `agents/gan-evaluator.md` at Q5's implementation (deferred to that PR per the file's
  convention).
- `runtime-knobs.md` records the two new stack fields if its inventory tracks schema fields
  (deferred to the implementation PR); no new flag/env/prompt-branch is introduced.
- New user-facing strings (the `absenceMessage` default, any documentation-finding text) obey
  the F4 error-text discipline.
- E3's "Hygiene-check coverage" reading holds: documentation criteria carry weight comparable
  to functional criteria — a run that passes every functional criterion but fails a gating
  documentation criterion is not a passing run.

## Dependencies

- **C1** — stack plugin schema (shipped). Q5 adds two optional fields and reuses C1's
  template-instantiation protocol verbatim; C1 is not edited (roadmap cross-reference; the
  schema field additions land in the implementation PR).
- **C2** — stack detection and dispatch (shipped). Documentation surfaces and `docLintCmd`
  inherit C2's active-set union and scope-filtered rule application unchanged.
- **C3** — overlay schema (shipped). `proposer.suppressSurfaces` / `additionalCriteria` /
  `evaluator.additionalChecks` carry Q5's customisation; the suppress existence-check
  generalises to the security ∪ documentation surface-id union. C3 is not edited.
- **C5** — stack-file resolution (shipped). Forking a stack file replaces the documentation
  standard wholesale; the stack-vs-overlay asymmetry applies.
- **E1 / E2** — agent integration + built-in stack extraction (shipped). Q5's implementation
  rewrites the proposer and evaluator prompts in place (`M` rows); the prompts gain a
  documentation clause parallel to the security clause, with no embedded standard.
- **E3** — evaluator pipeline harness (shipped). Q5 adds a `docLintInvocations` plan entry and
  one pure deterministic-core function plus golden coverage; E3 is not edited.
- **R4** — maintainer tooling (shipped). `lint-no-stack-leak` is the permanent backstop that
  keeps the documentation standard out of agent prompts and ecosystem tokens in their owning
  stack files; `lint-stacks` validates the new fields. No R4 change is required.
- **T1** — structured run trace (shipped). Documentation criteria are scored into the existing
  evaluator evidence bundle, keyed by criterion name; no schema change.
- **Q1** — diff acceptance feedback loop (v1.2, draft). Shares the v1.2 quality-signal slice
  and the delta/ratchet integrity-probe substrate; no coupling.

## Bite-size note

Sprintable as:

1. (one sprint) Schema + lint: add `documentationSurfaces` and `docLintCmd` to
   `schemas/stack-vN.json`; extend `scripts/lint-stacks` validation; author the default fields
   in `stacks/web-node.md` and `stacks/generic.md` and the synthetic guard-rail fixture.
2. (one sprint) Proposer: add the "Sourcing documentation criteria" section to
   `agents/gan-contract-proposer.md` (template-instantiation parallel to security); verify
   `lint-no-stack-leak` stays green; instantiation + cross-stack-namespace + suppress tests.
3. (one sprint) Evaluator-core + evaluator prompt: add the `docLintInvocations` plan entry and
   the pure core function (scope-filtered, baseline-relative, absence-tolerant); add E3 golden
   coverage; add `docLintCmd` to `agents/gan-evaluator.md`'s snapshot inputs; severity/gating
   tests.
4. (one sprint) Implementation-time docs: `retirements.md` `M` rows for the two rewritten
   prompts; any `runtime-knobs.md` field notes; flip Q5's roadmap entry to the shipped form.

Slices 1–3 land in order (2 and 3 depend on 1); slice 4 lands with the implementation PR.
