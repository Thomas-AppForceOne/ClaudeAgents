# 01 — Kotlin/Gradle secrets glob

**Status:** Phase 1 quick win. Superseded by spec 06 once Phase 2 ships — the Kotlin secrets glob migrates into `stacks/kotlin.md` and this in-agent patch is removed. Do not re-land this spec's changes if spec 06 has already shipped.

## Problem

`gan-evaluator.md` runs a hardcoded grep for hardcoded credentials using this file-extension list:

```
*.{js,ts,py,go,rs,rb,java,env,json,yaml,yml,toml,sh}
```

Kotlin (`.kt`), Kotlin scripts (`.kts`), and Gradle Kotlin DSL (`.gradle.kts`) are missing. A project whose code is primarily Kotlin will have its secrets scan silently pass over most of the codebase.

## Proposed change

Add `kt`, `kts` to the extension list in the evaluator's secrets-scan command. Also add `gradle` for Groovy-DSL Gradle files.

## Acceptance criteria

- The evaluator's secrets grep matches a hardcoded `api_key = "sk-..."` in a `.kt` file.
- The evaluator's secrets grep matches the same literal in a `build.gradle.kts` file.
- Existing stacks (JS/TS/Python/…) continue to be matched — no regression.

## Dependencies

None. Strictly additive.

## Value / effort

- **Value**: high. Closes a silent false-negative for any Kotlin project (Android, KMP, server-side Kotlin).
- **Effort**: trivial — a single-line change in one agent prompt.
