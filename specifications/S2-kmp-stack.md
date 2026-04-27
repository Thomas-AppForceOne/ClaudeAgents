# S2 — Kotlin Multiplatform (KMP) stack

## Problem

KMP projects share Kotlin code across multiple targets (Android, iOS, JVM, JS, native). Modelling KMP as plain Android misses:

- `expect`/`actual` declarations — platform-specific security details may only exist on some targets.
- Multiple test-command shapes — `./gradlew :shared:jvmTest`, `:shared:iosSimulatorArm64Test`, etc.
- `commonMain` vs platform source sets for the secrets glob (no new extensions, but different directory semantics).
- Test targets may require a simulator (iOS) that the evaluator cannot assume is available.

## Proposed change

Add `stacks/kmp.md` as a **sibling** of `stacks/android.md` (not a replacement). In a KMP+Android project, the dispatcher (spec C2) activates both and agents take the union.

Contents:

- **detection**: `build.gradle.kts` applying `org.jetbrains.kotlin.multiplatform`.
- **secretsGlob**: inherited from `stacks/kotlin.md` via detection-union; KMP adds nothing.
- **auditCmd**: inherited from `stacks/gradle.md` via detection-union; KMP does not restate Gradle audit logic.
- **buildCmd**: `./gradlew assemble` (or a documented subset if target-coverage is too slow).
- **testCmd**: `./gradlew allTests` or, if too slow, a documented subset (`jvmTest` plus one native target). Stack file should state the trade-off explicitly so agents pick sensibly.
- **lintCmd**: `./gradlew detekt` (or project-configured equivalent) — optional; omit if not configured.
- **securitySurfaces**:
  - `expect_actual_gaps` — a security-relevant `expect` declaration must have `actual` implementations on every active target; missing targets are blocking concerns.
  - `common_code_no_platform_api` — `commonMain` must not reach for platform-specific crypto or storage; platform-specific security calls belong in `*Main` source sets behind an `expect`/`actual` boundary.
  - `ios_keychain_usage` — when the iOS target is active, sensitive data uses Keychain, not `NSUserDefaults`.
  - Inherits Android surfaces when Android target is active — handled by union dispatch, not duplicated here.

## Acceptance criteria

- A KMP project with Android + iOS + JVM targets activates `stacks/kmp.md` alongside `stacks/android.md`.
- The contract-proposer generates `expect_actual_gaps` criteria only when the sprint introduces new `expect` declarations.
- On a KMP project without an iOS simulator available, the evaluator records the skipped target as a blocking concern rather than silently passing.
- A JVM-only KMP library project activates `kmp.md` but not `android.md`.

## Dependencies

- C1, C2, S1 (shares the Kotlin/Gradle pieces already extracted; S1 also validates whether the schema supports surface templates).

## Value / effort

- **Value**: medium-high — KMP is growing and no existing tooling covers it. Also stress-tests the polyglot union logic from spec C2.
- **Effort**: medium. The hardest part is `runCmd` pragmatics (what to actually run given variable target availability). Keep the stack file honest about skipped targets.
