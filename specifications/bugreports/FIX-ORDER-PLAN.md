# Bug-fix order plan

Eight bugs on this plan. Eight closed in Phase 0 — see each BR's Status header for the reason.

Phase 1 and Phase 2 pair coordinated bugs (same root, two pipeline roles / same artefact, two defects). The pair's fixes should land together or in adjacent diffs.

## Phase 0 — Closed

BR-001, BR-002, BR-003, BR-009, BR-010, BR-013, BR-015, BR-016.

## Phase 1 — Contract quality pair

### 1A. BR-007 — proposer pre-flight name resolution

- Validate cited names in proposed criteria before the contract is locked. Scope: `npm run X` script references.
- Update the evaluator prompt so "intent satisfied" can no longer paper over a name miss.

### 1B. BR-006 — contract-reviewer fresh-context + cited-name resolution framing

- Add fresh-context / cold-read framing to `agents/gan-contract-reviewer.md`.
- Add explicit script-name resolution as a reviewer check on first-pass drafts.
- Normalise the verdict-shape: pick one of `decision` / `verdict` and update the spec.

## Phase 2 — Evaluator artefact pair

### 2A. BR-004 — evaluator-output filename canonicalisation

- Pick one of `sprint-N-feedback-A.json` or `sprint-N-evidence-A.json`.
- Update agent prompt, SKILL.md, and the H1 confinement hook write-allow pattern consistently.
- Refuse non-canonical variants at H1.

### 2B. BR-008 — evaluator-prompt digest stamp

- Add a digest field (`evaluatorPromptDigest` / `promptHash` / `promptVersion`) to `evaluator-evidence-bundle-v1.json`. Required.
- Orchestrator stamps the digest at evaluator spawn; assert on read.
- Coordinate the schema-version bump with 2A so consumers see one transition.

## Phase 3 — Captured-output channel

### 3A. BR-012

- Extend T1's `trace/payloads/` with a new event class for captured shell/browser output, or define a typed subdirectory under `trace/`. Document in T1, SKILL.md, evaluator prompt.
- Retire `evaluator-logs/` and `evaluator-logs-B/` at the evaluator-prompt level; add H1 write-refusal for the legacy names.
- Channel choice must not foreclose Q2's structured-error vocabulary (v1.1).

## Phase 4 — Independent

### 4A. BR-005 — generator-objection schema + dispatcher

- Add `schemas/generator-objection-v1.json`.
- Orchestrator branch: on `OBJECTION-RAISED`, read the objection artefact, route to contract-proposer for revision, re-run generator on the revised contract.
- Surface objections in `progress.json` for cross-run analysis.
- End-to-end fixture exercising the objection loop.

### 4B. BR-011 — clarified-spec validation

- Pick one: (a) `schemas/clarified-spec-v1.json` wired into the orchestrator's post-clarification read; (b) section-presence + frontmatter lint; (c) drop the "document schema" references from `E5-spec-clarification.md` and SKILL.md.
- Refuse a clarified-spec byte-identical to the source spec.

### 4C. BR-014 — `web-node` lintCmd

- Decide: declare `lintCmd: eslint .` (or similar) or remove `lintCmd` entirely.
- If removed: add `absenceSignal: warning` support for `lintCmd` in `stack-v1.json`.
- Lint check: warn on stack manifests where `lintCmd === testCmd` or where `lintCmd` names a known test-runner binary.
