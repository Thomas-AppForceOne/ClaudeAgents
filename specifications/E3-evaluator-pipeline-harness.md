# E3 — Evaluator pipeline harness

## Problem

The evaluator agent has two separable jobs:

1. **Deterministic pipeline.** Given a resolved snapshot, a sprint plan, and the worktree state, decide which stacks are active, which `securitySurfaces` fire on which files, which commands to run, which keywords to grep, and what file scope each rule applies to. Pure data flow over typed inputs.
2. **LLM analysis.** Given those surfaces and that diff, decide whether the change satisfies criterion X.

Job 1 is testable with golden files and produces deterministic outputs. Job 2 is testable only with an LLM; its outputs vary even at fixed temperature. Most regression risk lives in Job 1 — a stack rename drops a surface, scope filtering fires on the wrong files, a polyglot repo cross-contaminates a sister stack's files. A "capability harness" that tests *only* Job 1 is honest and high-leverage; a harness that mocks Job 2 and calls itself a capability check is lying about scope.

This spec defines the harness for Job 1. Job 2 evaluation (scoring actual LLM outputs against goldens with tolerance) is a separate, optional, low-cadence concern; this spec does not address it.

## Proposed change

The evaluator agent has a **deterministic core** that produces a structured "evaluator plan" before any LLM analysis runs. The harness exercises that core directly with golden-file diffs.

### The deterministic core

The evaluator's deterministic core takes:

- The resolved snapshot from `getResolvedConfig()` (per F2).
- The sprint plan (set of files the planner says will be touched, plus the criteria the contract-proposer issued).
- The current worktree state (which files exist, which match each stack's `scope`).

It produces an **evaluator plan**: a structured JSON document listing every check the evaluator would run, in deterministic order, with full provenance:

```json
{
  "activeStacks": [
    {"name": "web-node",        "scope": ["**/*.js", "**/*.ts", "**/*.tsx", "package.json"]},
    {"name": "synthetic-second", "scope": ["**/*.synth", "**/synthetic.toml"]}
  ],
  "secretsScans": [
    {"stack": "web-node", "extension": "ts", "files": ["src/handler.ts"]}
  ],
  "auditCommands": [
    {"stack": "web-node", "command": "npm audit --audit-level=high", "absenceSignal": "blockingConcern"}
  ],
  "buildTestLint": {
    "buildCmd": "npm run build",
    "testCmd":  "npm test",
    "lintCmd":  "npm run lint"
  },
  "securitySurfacesInstantiated": [
    {
      "stack": "web-node",
      "id": "express_route_input",
      "templateText": "Express route handlers must validate untrusted input before passing to query / shell / fs APIs.",
      "triggerEvidence": {
        "scopeMatched": ["src/handler.ts"],
        "keywordsHit":  ["app.get(", "req.query"]
      },
      "appliesToFiles": ["src/handler.ts"]
    }
  ],
  "evaluatorAdditionalChecks": [
    {"command": "npm run typecheck", "on_failure": "blockingConcern", "tier": "project"}
  ]
}
```

Every entry traces to a stack file, an overlay tier, a sprint plan, or a keyword match — all expressible as deterministic functions of the inputs. Nothing here requires an LLM.

The LLM portion of the evaluator runs *after* this core, taking the evaluator plan as input alongside the diff and the criteria, and emitting the per-criterion verdict. That portion is not exercised by this harness.

### Harness layout

```
tests/fixtures/stacks/
  <fixture-name>/
    .claude/gan/                        # if the fixture has overlays
    src/                                # the fixture project
    sprint-plan.json                    # synthetic sprint-plan input
    expected-evaluator-plan.json        # golden file
```

`sprint-plan.json` is a synthetic input that simulates what the planner + contract-proposer would have produced for this fixture. The harness reads this plus the fixture's project state plus the resolved snapshot, runs the deterministic core, and diffs the output against `expected-evaluator-plan.json`.

### Bootstrap fixture set

- `js-ts-minimal/` — JS/TS project exercising web-node detection and surfaces.
- `synthetic-second/` — fixture-only synthetic stack used as a multi-stack guard rail (per the roadmap's cross-cutting principle). Not a real ecosystem; a minimal stack that exercises every C1 schema field, both detection composites (`allOf` and `anyOf`), the cacheEnv path, the securitySurfaces keyword + scope path, and `lintCmd.absenceSignal`. Lives at `tests/fixtures/stacks/synthetic-second/.claude/gan/stacks/synthetic-second.md`.
- `polyglot-webnode-synthetic/` — cross-contamination check: a single fixture that activates both `web-node` and `synthetic-second`, with files placed so each stack's surfaces apply only to its own scope. Replaces the earlier polyglot fixture proposed against deferred ecosystems.
- `node-packaged-non-web/` — tightened web-node detection check (must fall through to generic).
- `generic-fallback/` — repo with no recognised stack; exercises generic.

Each fixture's `expected-evaluator-plan.json` is hand-authored and asserts what the deterministic core *should* produce. Goldens are reviewed like any other artifact.

### Cross-stack capability assertion

The harness explicitly asserts the deterministic core produces correct, ecosystem-agnostic output for `synthetic-second/` side-by-side with `js-ts-minimal/`. This is the third leg of the multi-stack guard rail (alongside R4's `lint-no-stack-leak` and R1's in-tree synthetic stack file): if a framework change preserves correctness for `js-ts-minimal/` but breaks `synthetic-second/`, the harness fails.

Concretely:

- The harness fails if either fixture's output diff is non-empty.
- The harness fails if a code change deletes `synthetic-second/` or removes its `expected-evaluator-plan.json` without an explicit maintainer override flag (`--allow-guardrail-removal`, refused in CI).
- The harness fails if `polyglot-webnode-synthetic/`'s output shows surfaces from one stack applied to files in the other's scope. Cross-contamination regressions are caught by this fixture, not by `js-ts-minimal/` alone.

### Normalisation

The evaluator plan is structured JSON; normalisation is simpler than for free-text agent output.

1. **Sort arrays** with no semantic order: `activeStacks` by `name`, `secretsScans` by `(stack, extension)`, file lists alphabetically. The list of fields to sort is declared in `tests/fixtures/normalise-rules.json`.
2. **Canonicalise paths** by stripping any worktree-id segments. Fixture paths are repo-relative.
3. **Stable JSON formatting**: sort object keys, two-space indent, trailing newline.

No timestamps, PIDs, or token counts appear in the evaluator plan — those belong to the LLM-driven evaluation step which this harness does not exercise.

### Reference implementation

`scripts/evaluator-pipeline-check/` (Node 18+, per R4). Imports the evaluator's deterministic-core functions from `src/agents/evaluator-core/` (a module E1 carves out as part of the agent rewrite) and runs them against each fixture.

CI invokes via a workflow named `test-evaluator-pipeline.yml` (replaces `test-capability.yml` from earlier roadmap drafts; the new name matches the harness's actual scope).

### What this harness does not test

- LLM verdicts on actual criteria. The deterministic core decides *what* to check; the LLM decides *whether* the change passes. The harness asserts the former and not the latter.
- Free-form evaluator output (rationale text, blocker descriptions written by the LLM).
- Token usage or model-specific behavior.
- **Post-diff state.** The harness inputs are *pre-diff*: the worktree as it stands before the generator runs. C1's keyword-trigger algorithm explicitly says "search the touched files (existing content + proposed diffs if available)." A regression in post-diff keyword matching (e.g. a glob library quirk on a path with brackets, a regex anchored to line start that should have matched a diff hunk) would slip past this harness because it never sees a generator's diff. The harness's claim is therefore narrower than it might appear: it tests **the deterministic pipeline's pre-diff decisions**, not the runtime evaluator end-to-end.
- **Planner-driven inputs to `appliesToFiles`.** The deterministic core takes a sprint plan as input. In production, the sprint plan is the *planner agent's* output — and the planner is LLM-driven. The harness sidesteps planner variance by using a synthetic `sprint-plan.json`. So `securitySurfacesInstantiated.appliesToFiles` is deterministic *given a fixed plan*; production inherits planner variance through this path. Honest framing: harness verifies the function's purity, not the agent's overall determinism.

### Determinism prerequisites

The harness inherits the framework's canonical determinism pins from [F3's "Determinism" section](F3-schema-authority.md): picomatch for glob, sorted-input file enumeration, stable JSON formatting, V8 RegExp. The harness does not introduce its own additional pins. Diverging from any F3 pin in a future revision invalidates the goldens and requires a `--update-goldens` pass; the determinism pins are part of the harness contract via reference.

### Future-proofing: gate new trigger types

Today every `securitySurfaces` decision is keyword + glob — both expressible as pure functions. A future surface that needs LLM-aided semantic detection ("this diff introduces *intent* to expose data") cannot live in the deterministic core; if added, it would silently shrink the harness's coverage of "the deterministic pipeline" without anyone noticing.

**Rule for new trigger types:** any `securitySurfaces.<id>.triggers.<type>` introduced in a future C1 revision must be expressible as a pure function over (file content, file path, sprint plan). Trigger types that require an LLM call go *outside* the deterministic core, and their absence from this harness must be called out in the spec that introduces them.

### Optional follow-up: LLM evaluation suite (E4)

A separate, optional spec (placeholder name **E4**) may specify a low-cadence LLM-evaluation suite that runs *after* the deterministic core, scores actual LLM outputs against goldens with tolerance, and serves as a regression check on agent prompts. This requires Anthropic API access in CI and a budget envelope.

**E4 is not gating for E2.** E2 can land with the deterministic-core harness alone. The team can pursue E4 later if agent-prompt regression cost justifies the CI spend.

If E4 is later authored:

- Its fixture inputs are this harness's outputs (deterministic-core results become E4's inputs alongside diffs).
- It specifies tolerance rules (semantic-similarity thresholds, fixed yes/no checks where determinism is achievable, retry logic).
- It specifies the CI cost envelope and key-management story before any CI integration.

Until E4 exists, agent-prompt regressions are caught by ad-hoc manual testing on real `/gan` runs, not CI. That is acceptable for pre-1.0.

## Acceptance criteria

- The evaluator agent exposes a `src/agents/evaluator-core/` module of pure functions over typed inputs (snapshot, sprint plan, worktree state) returning a structured evaluator plan.
- `tests/fixtures/stacks/<fixture>/expected-evaluator-plan.json` exists for every bootstrap fixture, hand-authored.
- `node scripts/evaluator-pipeline-check` runs every fixture's deterministic core against its golden and exits 0 on empty diff, non-zero with a structured human-readable diff otherwise.
- The diff is normalised per `tests/fixtures/normalise-rules.json`; modifying rules requires a reviewable commit.
- The harness output never contains run-volatile data (timestamps, run-ids, etc.) so a CI failure log is reproducible from the same commit.
- The harness exits the same way regardless of whether an LLM is reachable; no Anthropic-API access is required.
- Adding a new fixture requires no harness change beyond placing the fixture and its `expected-evaluator-plan.json`.
- A `--update-goldens` flag captures the deterministic core's current output and writes it to the goldens; running it twice in a row is a no-op.

## Dependencies

- C1, C2 (data the fixtures exercise)
- E1 (carves out `src/agents/evaluator-core/` as part of the agent rewrite)

E2 is gated by this harness in implementation, not the other way around. R4 hosts the reference script's filename in its directory layout but the format described here is authored independently of R4.

## Bite-size note

Sprintable as: harness skeleton + one fixture (`js-ts-minimal`) + normalisation rules → cross-contamination fixture → remaining bootstrap fixtures → `--update-goldens` flag → CI integration. The deterministic-core extraction in `src/agents/evaluator-core/` is E1's work, not this spec's, but it is the dependency that unblocks slice 1.
