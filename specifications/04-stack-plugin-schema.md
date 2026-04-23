# 04 — Stack plugin schema

## Problem

Today, stack-specific logic is mixed into every agent prompt: the planner has a list of detection rules (`pyproject.toml` → Python, `package.json` → JS/TS, …), the evaluator has a hardcoded secrets glob, the contract-proposer's security checklist assumes a web server. Adding a new stack means editing every agent. This does not scale and forces stacks to be biased toward the one the repo was written against (web/node).

## Parse contract

A stack file is a markdown document with **one YAML frontmatter block** and **one canonical YAML body block**. Agents never parse markdown prose for semantic content.

```
---
name: android
description: Android client (Gradle, Kotlin/Java)
schemaVersion: 1
---

```yaml
detection:
  - settings.gradle.kts
  - settings.gradle
  - path: build.gradle.kts
    contains: ["com.android.application", "com.android.library"]

scope:
  - "**/*.kt"
  - "**/*.kts"
  - "**/AndroidManifest.xml"
  - "**/build.gradle*"
  - "**/src/main/**"

secretsGlob:
  - kt
  - kts
  - java
  - gradle
  - gradle.kts
  - xml
  - properties
  - env
  - json
  - yaml
  - yml

cacheEnv:
  - envVar: GRADLE_USER_HOME
    valueTemplate: "<worktree>/.gan-cache/gradle"

auditCmd:
  command: "./gradlew dependencyCheckAnalyze"
  fallback: "./gradlew :app:dependencyCheckAnalyze"
  absenceSignal: blockingConcern
  absenceMessage: "No dependency-audit tool configured for this Gradle project."

buildCmd: "./gradlew assembleDebug"
testCmd: "./gradlew testDebugUnitTest"
lintCmd: "./gradlew lintDebug"

securitySurfaces:
  - id: exported_components
    template: >
      Activities/Services/Providers declared `android:exported="true"` must
      validate caller identity or intent extras.
    triggers:
      scope: ["**/AndroidManifest.xml", "**/*Activity.kt", "**/*Service.kt"]
      keywords: ["android:exported=\"true\"", "<activity", "<service"]
  - id: webview_js_bridge
    template: >
      `addJavascriptInterface` usage must gate methods with `@JavascriptInterface`
      and restrict the loaded origin.
    triggers:
      keywords: ["addJavascriptInterface", "WebView"]
```

## conventions
Optional free-text markdown after the YAML block. Not machine-parsed; agents
pass it verbatim to any model that reads the stack file as context.
```

Rules:

- **Frontmatter** carries only file-level identity (`name`, `description`, `schemaVersion`).
- **The body YAML block** (first fenced ```` ```yaml ```` block after the frontmatter) is the **sole source of semantic content**. Any field defined in this spec is required to live there.
- **Markdown headings and prose** after the YAML block are for human readers only. Agents never extract fields from them.
- The lint script (see acceptance criteria) validates the body YAML against a published JSON-schema.

## Field reference

### detection
Array of patterns that activate this stack. Each entry is either a string glob (matched against repo paths) or an object `{ path, contains }` (path glob that must *also* contain one of the given strings). Multiple entries OR together.

### scope
Array of globs describing which files in the repo this stack *owns*. Used by agents to avoid cross-contamination in polyglot repos: a stack's `securitySurfaces`, `secretsGlob`, `auditCmd`, `buildCmd`/`testCmd`/`lintCmd` only apply to files inside its scope.

**Precedence with `detection`:** `detection` decides whether the stack is active at all; `scope` decides which files its rules apply to once active. A file matching `detection` but outside `scope` contributes to activation but is not evaluated against this stack's rules.

**Default:** if omitted, `scope` is the union of `detection` path globs and `**/*.{ext}` for every extension in `secretsGlob`.

**Worked example — polyglot Android + Python repo:**

```
repo/
  android/app/src/main/kotlin/Foo.kt     → in android.scope, not in python.scope
  android/app/src/main/AndroidManifest.xml → in android.scope, not in python.scope
  services/api/src/main.py               → in python.scope, not in android.scope
  scripts/release.py                     → in python.scope, not in android.scope
```

Both stacks are active (both detections match). Android's `exported_components` surface evaluates only `android/app/**`; Python's secrets glob evaluates only `services/api/**` and `scripts/**`. A `.py` file is never checked against Android surfaces.

### secretsGlob
Array of file extensions (no leading dot) the evaluator's secrets grep inspects. Applied only to files inside `scope`.

### cacheEnv
Array of `{ envVar, valueTemplate }` objects. The skill orchestrator exports each entry before running any command from this stack, substituting `<worktree>` with the absolute worktree path.

**Conflict resolution (polyglot repos):** when two active stacks declare `cacheEnv` entries with the same `envVar`:
1. If the `valueTemplate` strings are identical, export once. No conflict.
2. If they differ, the run halts with a hard error: `cacheEnv conflict: <envVar> declared differently by <stackA> and <stackB>`. The user must resolve via an overlay (spec 09 `stack.override` or a project-tier replacement per spec 12).

### auditCmd
Object with:
- `command` (string, required) — the audit command to run.
- `fallback` (string, optional) — alternate command to try if the primary exits nonzero with a "not configured" signal.
- `absenceSignal` — one of `blockingConcern`, `warning`, `silent`.
- `absenceMessage` (string, required if `absenceSignal` ≠ `silent`).

Applied only to files inside `scope`.

### buildCmd / testCmd / lintCmd
Strings. Separate fields so failure signals stay distinct and overlays (specs 09/11) can override one phase at a time. **Legacy `runCmd` is rejected by the lint script** — stacks that previously combined phases must split them.

### securitySurfaces
Array of surfaces this stack exposes, each with a template criterion the contract-proposer may instantiate. See "Template instantiation protocol" below.

## Template instantiation protocol

The contract-proposer decides whether to instantiate a `securitySurfaces` entry as a contract criterion using the surface's `triggers` block:

```yaml
triggers:
  scope: ["**/AndroidManifest.xml", "**/*Activity.kt"]   # optional
  keywords: ["android:exported", "<activity"]            # optional
```

Algorithm, per surface per sprint:

1. Compute the set of files the sprint's plan will *touch* (create, modify, or delete), as declared by the planner's spec output.
2. Intersect that set with the surface's `triggers.scope` globs (if present) AND the stack's own `scope` globs. If the intersection is empty, skip this surface.
3. If `triggers.keywords` is present, search the touched files (existing content + proposed diffs if available) for any keyword. If none match, skip this surface.
4. Otherwise, instantiate the `template` string as a contract criterion. The `template` is used verbatim — no interpolation. Variables (file paths, keyword hits) are recorded as *rationale* alongside the criterion, not substituted into it.

Both `triggers.scope` and `triggers.keywords` are optional. A surface with neither is instantiated unconditionally whenever the stack is active and the sprint touches any file in the stack's `scope`.

The contract-proposer prompt loses its hardcoded security checklist; all security criteria originate from active stacks' `securitySurfaces`. (Retirement of the hardcoded checklist is spec 06's responsibility.)

## Versioning

- **Current version:** `schemaVersion: 1`. Every stack file must declare it.
- **Compatibility policy:** agents refuse to load a stack file with `schemaVersion` higher than the agent's known version — hard error, naming the file and the two versions. Agents load lower versions that still match their known schema (only additive changes between versions; see below).
- **Bump policy:** bump the version only when a **breaking** change lands (field removed, semantics changed). Additive changes (new optional field) do not bump — existing stack files remain valid.
- **Migration:** when a version bump happens, the repo ships a migration note and a lint rule; agents do not auto-migrate stack files.

## Acceptance criteria

- A new `stacks/example.md` file following the parse contract can be dropped in without editing any agent.
- The parse contract and field reference are documented in the repo README.
- The schema frontmatter includes a `schemaVersion` field; current value is `1`.
- A JSON-schema lint script validates every `stacks/*.md` body-YAML at CI time.
- The lint script rejects: legacy `runCmd`, unstructured (string) `auditCmd`, markdown prose outside the YAML block that references schema fields, missing `schemaVersion`.
- Loading a stack with `schemaVersion` greater than the agent's known version produces a hard error naming the file and both versions.
- A polyglot repo where two active stacks declare `cacheEnv` entries for the same `envVar` with different `valueTemplate`s halts with the conflict error from "Conflict resolution" above.
- The contract-proposer instantiates a `securitySurfaces` entry iff the template-instantiation protocol's conditions hold; sprints that don't touch a surface's scope or keywords do not surface that criterion.

## Dependencies

None from earlier specs. Prerequisite for 05, 06, 07, 08, 09, 11, 12.

## Value / effort

- **Value**: foundational. Unlocks every later phase.
- **Effort**: medium. Most of the cost is careful schema design — too flexible and stacks drift; too narrow and real stacks can't be expressed. Keep the first version minimal; grow deliberately.
