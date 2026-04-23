# 04 — Stack plugin schema

## Problem

Today, stack-specific logic is mixed into every agent prompt: the planner has a list of detection rules (`pyproject.toml` → Python, `package.json` → JS/TS, …), the evaluator has a hardcoded secrets glob, the contract-proposer's security checklist assumes a web server. Adding a new stack means editing every agent. This does not scale and forces stacks to be biased toward the one the repo was written against (web/node).

## Proposed change

Define a single schema used by all agents: `stacks/<name>.md`. Each file declares everything the agents need to operate on that stack:

```
---
name: android
description: Android client (Gradle, Kotlin/Java)
---

## detection
Files or directory patterns that identify this stack. Multiple may match in a
polyglot repo. **This schema is the single authority for how detection rules
are declared.** The evaluation algorithm (union, scope filtering, fallback to
generic, tier restriction) is owned by spec 05. Individual stack specs
(06, 07, 08, …) must declare only their stack-unique patterns here — they
must not restate algorithm behavior.

- settings.gradle.kts, settings.gradle
- build.gradle.kts with `com.android.application` or `com.android.library`

## scope
Glob(s) describing which files in the repo this stack *owns*. Used by agents
to avoid cross-contamination in polyglot repos: a stack's security surfaces,
secrets glob, and audit command only apply to files inside its scope. If
omitted, scope defaults to the detection patterns plus any files with
extensions listed in `secretsGlob`.

- **/*.kt, **/*.kts, **/AndroidManifest.xml, **/build.gradle*, **/src/main/**

## secretsGlob
File-extension list for the evaluator's secrets grep.

- kt, kts, java, gradle, gradle.kts, xml, properties, env, json, yaml, yml

## cacheEnv
Environment variables the skill must set (scoped to the worktree) before
running any command from this stack, to avoid daemon/lockfile collisions
between concurrent worktrees. Each entry is `{ envVar, valueTemplate }`;
`<worktree>` in `valueTemplate` is substituted with the absolute worktree
path at run time. Optional — omit for stacks whose tools have no shared
user-level cache. (Supersedes the Phase 1 hardcoded catalog in spec 03.)

- GRADLE_USER_HOME: `<worktree>/.gan-cache/gradle`

## auditCmd
Command to run during the dependency-audit pass, and how to interpret its
exit code / output. Structured so agents never have to parse prose.

- command: `./gradlew dependencyCheckAnalyze`
- fallback: `./gradlew :app:dependencyCheckAnalyze` (optional)
- absenceSignal: blockingConcern
- absenceMessage: "No dependency-audit tool configured for this Gradle project."

## buildCmd
Command that compiles/assembles the project without running tests or lint.

- `./gradlew assembleDebug`

## testCmd
Command that runs the stack's unit/integration tests.

- `./gradlew testDebugUnitTest`

## lintCmd
Command that runs the stack's linter/static analysis. Separate from build
and test so agents can report lint failures distinctly and overlays can
override lint without rewriting the whole command pipeline.

- `./gradlew lintDebug`

## securitySurfaces
List of surfaces this stack exposes, each with a **template** criterion the
contract-proposer can instantiate when the sprint touches that surface.
Surfaces are scoped: they only apply to sprints that modify files inside
this stack's `scope`.

- exported_components: "Activities/Services/Providers declared `android:exported=\"true\"` must validate caller identity or intent extras."
- deep_links: …
- webview_js_bridge: …
- network_security_config: …

## conventions
Optional free-text pointer to stack-wide conventions or idioms.
```

**Legacy `runCmd` is removed.** Stacks that previously combined build/test/lint
into a single string must split them into `buildCmd`, `testCmd`, and `lintCmd`.
This keeps failure signals distinct and gives overlays (specs 09/11) a stable
surface to override one phase at a time.

The schema is a **contract** between agents and stack files. Changes to it are versioned; each stack file declares a schema version in its frontmatter.

## Acceptance criteria

- A new `stacks/example.md` file following the schema can be dropped in without editing any agent.
- The schema is documented in the repo README.
- The schema frontmatter includes a `schemaVersion` field so future changes are explicit.
- A JSON-schema or equivalent lint script validates every `stacks/*.md` at CI time.
- The lint script rejects any stack file that still uses the legacy `runCmd` field — stacks must use `buildCmd` / `testCmd` / `lintCmd`.
- `auditCmd` is accepted only as a structured object (`command`, optional `fallback`, `absenceSignal`, `absenceMessage`); free-text `auditCmd` fails the lint.

## Dependencies

None from earlier specs. Prerequisite for 05, 06, 07, 08, 09, 11, 12.

## Value / effort

- **Value**: foundational. Unlocks every later phase.
- **Effort**: medium. Most of the cost is careful schema design — too flexible and stacks drift; too narrow and real stacks can't be expressed. Keep the first version minimal; grow deliberately.
