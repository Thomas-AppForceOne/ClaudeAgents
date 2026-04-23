# 05 — Stack detection and dispatch

## Problem

Even with a schema defined (spec 04), agents need a uniform way to select which stack file to load for a given run. Today each agent has its own detection rules in prose; a shared mechanism is needed.

## Proposed change

Add a detection-and-dispatch step that every agent performs the same way:

1. Enumerate all `stacks/*.md` files (from the repo, for now — spec 12 extends this to three tiers).
2. Evaluate each stack's `detection` section against the target directory.
3. **Union** all matching stacks into the active set. A polyglot repo (e.g. KMP + Node backend) activates multiple stack files; agents treat the union of their fields.
4. **Scope-filter stack-specific criteria.** Union applies to *which* stacks are active, not to *how* each stack's rules are applied. Stack-scoped fields (`securitySurfaces`, `auditCmd`, `secretsGlob`, `lintCmd`, `testCmd`, `buildCmd`) are evaluated only against files inside that stack's `scope` (spec 04). In an Android + Python repo, Python files are not checked against Android security surfaces, and vice versa.
5. If no stack matches, activate `stacks/generic.md` — a conservative fallback that grep-searches broadly, runs tests if present, and skips anything it cannot do safely.
6. Record the active set in the agent's output (to be formalised in spec 13).

All agents share the same dispatch logic — codified as a short protocol in each agent's entry section, not reimplemented.

## Acceptance criteria

- A repo with only `package.json` activates exactly `stacks/web-node.md`.
- A repo with both `package.json` and `build.gradle.kts` activates both stack files; the secrets glob is the union of both.
- A repo with no recognised stack activates `stacks/generic.md` and the evaluator runs without errors.
- The active set is deterministic: same repo → same active stacks, every run.
- **No cross-contamination.** In a polyglot repo activating Android + Python, the evaluator does not apply Android security surfaces (e.g. `exported_components`, `webview_js_bridge`) to `.py` files, and does not apply Python-stack audit commands to Kotlin sources. Verified by a test fixture with one file per stack where each stack's criteria fire only against its scoped files.

## Dependencies

- 04 (schema)

## Value / effort

- **Value**: high. This is what actually makes the plugin system work end-to-end.
- **Effort**: medium. The dispatch protocol must be specified precisely enough that agents behave identically; a reference implementation in the skill may help, but agents still need to apply the active-set data.
