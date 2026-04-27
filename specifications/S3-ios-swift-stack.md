# S3 — iOS Swift / SwiftUI stack

**Status:** Stub. Drafted in Phase 5.

## Purpose

Add `stacks/ios.md` declaring detection, scope, security surfaces, and tooling for iOS apps written in Swift and SwiftUI. Validates that the stack-plugin schema (C1) handles a non-Gradle, non-Node ecosystem as cleanly as it handles Android and web.

## Anticipated content

- **detection:** `*.xcodeproj`, `*.xcworkspace`, `Package.swift`, `Podfile` — composite rule to distinguish iOS apps from generic Swift packages.
- **scope:** `**/*.swift`, `**/Info.plist`, `**/*.xcconfig`, `**/Package.swift`, `**/*.entitlements`, `**/*.storyboard`, `**/*.xib`.
- **secretsGlob:** `swift, plist, xcconfig, entitlements, json, yaml, yml`.
- **buildCmd / testCmd / lintCmd:** `xcodebuild` invocations for the active target/scheme. SwiftLint for lint when configured. Overlay-friendly so projects can pin scheme/destination.
- **auditCmd:** Swift Package Manager dependency surface; absence behavior follows C1's pattern.
- **securitySurfaces (anticipated):**
  - `keychain_usage` — sensitive data uses Keychain, not `UserDefaults`.
  - `ats_exceptions` — `NSAppTransportSecurity` exceptions are justified per host.
  - `url_scheme_handling` — declared URL schemes validate input before use.
  - `universal_links` — Associated Domains entitlements match `apple-app-site-association` claims.
  - `biometric_auth` — `LAContext` usage falls back safely on policy-evaluation failure.
  - `app_signing` — release builds use distribution certificates; entitlements match the bundle identifier.
  - `data_protection` — files containing user data declare an appropriate `NSFileProtection` class.

Detailed fields and triggers are drafted when this phase is reached.

## Dependencies

- C1 (stack plugin schema), C2 (detection / dispatch), R1 (Configuration API)

## Bite-size note

iOS-specific details (scheme/destination handling, codesigning, simulator availability) deserve their own focused authoring pass. The stub above is enough for the roadmap to reference; the substance is sprint work.
