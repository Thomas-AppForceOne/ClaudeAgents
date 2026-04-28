# Deferred specifications

Specs in this directory are **not part of the current implementation plan**. They have been authored, reviewed, and intentionally postponed until further notice.

## Why deferred

The original plan included three real-world stack files — Android (S1), Kotlin Multiplatform (S2), and iOS Swift / SwiftUI (S3) — as Phase 5 of the redesign. Pursuing them in lockstep with the foundational rewrite (Phases 0–4 + Phases 5–7 of the active roadmap) carried two risks:

1. **Premature schema commitments.** C1 (the stack plugin schema) has not yet been exercised against a non-Node ecosystem in production. Authoring three real ecosystem stacks before the framework has any operational mileage means encoding assumptions that are likely to need rework once the API has been used in anger.
2. **Scope inflation.** Each real stack carries a long tail of ecosystem-specific decisions (security surface catalogues, build/test/lint command matrices, polyglot interactions with KMP shared modules, iOS scheme/destination handling). Landing all three before the core has shipped delays the moment the framework can be used at all.

Deferring lets the active plan ship a usable framework on the bootstrap stack (`web-node`) and one fixture-only synthetic stack first. The synthetic stack — combined with R4's `lint-no-stack-leak` script and E3's cross-stack capability assertion — is the **guard rail** that keeps the framework genuinely multi-stack capable, even while only one real ecosystem ships. See the active roadmap's "Cross-cutting principles" section for that mechanism.

## Reactivation criteria

These specs become candidates for an active phase when **all** of the following hold:

- Phases 0–7 of the active roadmap have shipped and seen use on at least one real `/gan` consumer.
- The post-R, post-E1, and post-M revision breaks have closed without uncovering schema gaps that would force a C1 bump.
- A volunteer or maintainer commits to the per-stack work — these are not lightweight files; each is one to several sprints depending on security-surface depth.

When reactivated, the specs may need their own audit pass: the C1 schema and the C2 detection algorithm will likely have evolved by then. Treat the documents in this directory as a starting point that captures intent and security-surface coverage, not as ready-to-implement plans.

## Contents

- [S1-android-stack.md](S1-android-stack.md) — Android client stack file. Detection, security surfaces (exported components, deep links, WebView bridges, etc.), Gradle build/test/lint command matrix.
- [S2-kmp-stack.md](S2-kmp-stack.md) — Kotlin Multiplatform stack file. Sibling to S1 in a KMP+Android repo. Target-availability handling for iOS simulator and JVM-only configurations.
- [S3-ios-swift-stack.md](S3-ios-swift-stack.md) — iOS Swift / SwiftUI stack file. Detection (xcodeproj + Package.swift composite), `xcodebuild` / `swiftlint` command surface, signing / data-protection security surfaces.

## What this directory is not

- Not a backlog of speculative ideas. Each spec was reviewed and could ship today; the deferral is a scheduling decision, not a quality decision.
- Not a graveyard. Maintainers should resist the temptation to delete on tidy-up passes — the security-surface catalogues in these specs took real effort to compile.
- Not a public commitment. Calling a stack "deferred" does not promise it will ever ship; it promises only that the work captured here will be considered before any new author starts a stack file from scratch.
