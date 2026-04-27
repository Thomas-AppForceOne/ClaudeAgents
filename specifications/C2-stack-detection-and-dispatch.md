# C2 — Stack detection and dispatch

## Problem

Even with a schema defined (spec C1), agents need a uniform way to select which stack file to load for a given run. Today each agent has its own detection rules in prose; a shared mechanism is needed.

## Proposed change

**This spec is the single authority for the detection-and-dispatch algorithm.** Spec 04 owns the schema for *declaring* detection rules; spec C5 extends *where* stack files may be resolved from (three tiers) and adds the restriction that detection rules may only be declared at tier 3 (repo). Individual stack specs declare only their stack-unique patterns.

Add a detection-and-dispatch step that every agent performs the same way:

1. Enumerate all `stacks/*.md` files (from the repo, for now — spec C5 extends this to three tiers).
2. Evaluate each stack's `detection` section against the target directory.
3. **Union** all matching stacks into the active set. A polyglot repo (e.g. KMP + Node backend) activates multiple stack files; agents treat the union of their fields.
4. **Scope-filter stack-specific criteria.** Union applies to *which* stacks are active, not to *how* each stack's rules are applied. Stack-scoped fields (`securitySurfaces`, `auditCmd`, `secretsGlob`, `lintCmd`, `testCmd`, `buildCmd`) are evaluated only against files inside that stack's `scope` (spec C1). In an Android + Python repo, Python files are not checked against Android security surfaces, and vice versa.
5. If no stack matches, activate `stacks/generic.md` — a conservative fallback that grep-searches broadly, runs tests if present, and skips anything it cannot do safely.
6. Record the active set in the agent's output (to be formalised in spec O1).

All agents share the same dispatch logic — codified as a short protocol in each agent's entry section, not reimplemented.

## Error model

The dispatch step fails closed. Every error below halts the run with a clear message naming the offending file; none degrade silently.

- **Malformed stack file** — frontmatter missing, body YAML block absent, YAML parse error, or JSON-schema validation failure (per spec C1 lint). Error: `stack <path>: <validation detail>`. Applies uniformly whether the file is in `stacks/`, `~/.claude/gan/stacks/`, or `.claude/gan/stacks/` (tiers from spec C5).
- **schemaVersion mismatch** — stack file declares a `schemaVersion` greater than the agent's known version. Hard error per spec C1's versioning rules.
- **Invalid detection glob** — a pattern that cannot be parsed as a glob. Error: `stack <name>: invalid detection pattern <pattern>`.
- **cacheEnv conflict** — two active stacks declare the same `envVar` with different `valueTemplate` values. Handled per spec C1's "Conflict resolution" rule; the error surfaces here because dispatch is where the conflict becomes observable.
- **Overlay references unknown stack** — an overlay's `stack.override` (spec C3) names a stack not present in any tier. Error: `overlay forces stack <name> but no matching stack file found`.
- **Empty scope after activation** — a stack is active (detection matched) but its `scope` globs match no files. This is a *warning*, not an error: scope is there to filter rules, not to re-assert activation. The warning appears in the spec O1 startup log.

Absent errors: stacks whose `auditCmd` tool is not installed do not fail dispatch — that case is handled by the stack's `auditCmd.absenceSignal` at evaluation time.

## Interaction with overlay `stack.override` (spec C3)

When an overlay declares `stack.override`, it **replaces** the detection result — auto-detection is skipped and the active set is exactly the named stacks. This is the only way for users to activate a stack whose detection rules do not match the repo (spec C5 restricts detection declarations to tier 3).

Worked example:

```
Repo has: package.json (matches stacks/web-node.md detection)
Overlay: .claude/gan/project.md
  stack.override: [web-node, docker]
Result: active set = {web-node, docker}. Auto-detection is skipped.
         stacks/docker.md is activated even though its detection would not
         have matched (no Dockerfile present — maybe the project uses Compose
         files outside the default detection).
```

`stack.override` cannot be additive to detection — it is all-or-nothing. Users who want "auto-detected stacks plus one extra" must list the full set explicitly.

## `stacks/generic.md` fallback definition

`stacks/generic.md` ships with the repo (at tier 3, per spec C5) and is the activated stack when auto-detection finds zero matches and no overlay provides `stack.override`. Its body YAML:

```yaml
detection: []   # never auto-matches; only activated via fallback
scope:
  - "**/*"
secretsGlob:
  - env
  - json
  - yaml
  - yml
  - txt
  - md
  - ini
  - conf
  - cfg
cacheEnv: []
auditCmd:
  command: "true"
  absenceSignal: warning
  absenceMessage: "No dependency-audit tool is available for an unrecognised stack."
buildCmd: ""
testCmd: ""
lintCmd: ""
securitySurfaces:
  - id: plaintext_secrets
    template: >
      No hardcoded credentials, API keys, or private keys in any file.
    triggers:
      keywords: ["password", "secret", "api_key", "apikey", "token", "BEGIN PRIVATE KEY"]
```

Empty `buildCmd`/`testCmd`/`lintCmd` instruct the evaluator to skip those phases and record them as "not run — unrecognised stack" rather than fail. The generic stack never produces blocking concerns by itself; its purpose is to keep the evaluator running end-to-end on unknown projects.

## Acceptance criteria

- A repo with only `package.json` activates exactly `stacks/web-node.md`.
- A repo with both `package.json` and `build.gradle.kts` activates both stack files; the secrets glob is the union of both.
- A repo with no recognised stack activates `stacks/generic.md` and the evaluator runs without errors.
- The active set is deterministic: same repo → same active stacks, every run.
- **No cross-contamination.** In a polyglot repo activating Android + Python, the evaluator does not apply Android security surfaces (e.g. `exported_components`, `webview_js_bridge`) to `.py` files, and does not apply Python-stack audit commands to Kotlin sources. Verified by a test fixture with one file per stack where each stack's criteria fire only against its scoped files.

## Dependencies

- C1 (schema)

## Value / effort

- **Value**: high. This is what actually makes the plugin system work end-to-end.
- **Effort**: medium. The dispatch protocol must be specified precisely enough that agents behave identically; a reference implementation in the skill may help, but agents still need to apply the active-set data.
