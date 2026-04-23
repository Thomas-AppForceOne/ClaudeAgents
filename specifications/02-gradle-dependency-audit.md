# 02 — Gradle dependency audit branch

**Status:** Phase 1 quick win. Delete this spec the moment spec 06 lands — the Gradle audit logic (detection + `auditCmd` + "no audit tool configured" fallback) moves into `stacks/gradle.md` and this in-agent branch is removed wholesale. ClaudeAgents is pre-1.0; there is no dual-path window.

## Problem

The evaluator's dependency-audit pass runs `npm audit`, `pip-audit`, `cargo audit`, `govulncheck`, or `bundle audit` depending on the detected stack. For Gradle projects (Android, KMP, server-side Kotlin/Java) it falls through to "tool not installed — note in blockingConcerns and skip." A CVE-producing dependency therefore ships without a blocking concern on any Gradle project.

## Proposed change

Add a Gradle branch to the evaluator's dependency audit:

- Prefer the OWASP Dependency-Check Gradle plugin (`./gradlew dependencyCheckAnalyze`) if the project declares it.
- Otherwise, if the project uses a Gradle version catalog or `ben-manes/gradle-versions-plugin`, use those results as the signal.
- If neither is present, record the absence in `blockingConcerns` — consistent with how the evaluator handles other missing audit tools.

Detection: presence of `settings.gradle`, `settings.gradle.kts`, or a `gradle/` directory.

## Acceptance criteria

- On a Gradle project with a known-CVE dependency and OWASP dep-check configured, the evaluator surfaces the CVE as a blocking concern.
- On a Gradle project without any audit tooling, the evaluator records "no Gradle audit tool configured" as a blocking concern (not silently passes).
- On non-Gradle projects, behavior is unchanged.

## Dependencies

None. Independent of Phase 2.

## Value / effort

- **Value**: high. Without it, Gradle projects get a security pass with a silent gap.
- **Effort**: small — one branch added to the evaluator's audit step.
