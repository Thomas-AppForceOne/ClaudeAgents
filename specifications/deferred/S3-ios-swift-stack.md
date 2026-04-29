# S3 — iOS Swift / SwiftUI stack

## Problem

iOS apps written in Swift / SwiftUI are a major target ecosystem with concerns disjoint from web, Android, or KMP:

- No daemon / server to spawn; "run the app" means compile + unit test + lint, with simulator orchestration when UI tests are involved.
- Security surfaces are client-side: keychain usage, App Transport Security exceptions, URL scheme and universal-link handling, biometric authentication, code signing posture, data-protection class declarations.
- Tooling centres on `xcodebuild`, Swift Package Manager, and CocoaPods/Carthage in legacy projects.
- Detection is non-trivial: a `Package.swift` could be a generic Swift library or a SwiftPM-managed iOS app; `*.xcodeproj` could be macOS, iOS, watchOS, or tvOS.

S3 adds `stacks/ios.md` declaring everything `/gan` needs to operate on iOS apps. It is also the first non-Gradle, non-Node ecosystem to land on the schema, validating C1's portability.

## Proposed change

Add `stacks/ios.md` following C1's parse contract.

### Detection

```yaml
detection:
  - allOf:
      - anyOf:
          - "*.xcodeproj"
          - "*.xcworkspace"
          - "Package.swift"
      - anyOf:
          - path: Package.swift
            contains: ["platforms:", ".iOS("]
          - "*.xcodeproj/project.pbxproj"
            # an .xcodeproj implies an Apple-platform target, but we
            # want only iOS — confirm via the platform list inside
          - path: "*.xcodeproj/project.pbxproj"
            contains: ["SDKROOT = iphoneos", "platformFilter = ios"]
```

A bare `Package.swift` without iOS platform declaration falls through to `stacks/generic.md`. A `*.xcodeproj` is required to declare an iOS SDK target to activate this stack. macOS-only, watchOS, or tvOS projects are out of scope for v1 of `stacks/ios.md`.

### Scope

```yaml
scope:
  - "**/*.swift"
  - "**/*.m"
  - "**/*.mm"
  - "**/*.h"
  - "**/Info.plist"
  - "**/*.xcconfig"
  - "**/*.entitlements"
  - "**/Package.swift"
  - "**/*.xcodeproj/**"
  - "**/*.xcworkspace/**"
  - "**/*.storyboard"
  - "**/*.xib"
  - "**/Podfile"
  - "**/Cartfile"
```

### secretsGlob

```yaml
secretsGlob:
  - swift
  - m
  - mm
  - h
  - plist
  - xcconfig
  - entitlements
  - json
  - yaml
  - yml
```

### Build / test / lint

```yaml
buildCmd: "xcodebuild -scheme ${SCHEME} -destination ${DESTINATION} build"
testCmd:  "xcodebuild -scheme ${SCHEME} -destination ${DESTINATION} test"
lintCmd:  "swiftlint --strict"
```

`SCHEME` and `DESTINATION` are placeholders resolved from the project overlay's `modules.ios.yaml` config (a future `src/modules/ios/` may produce them automatically; for v1 they are user-declared). When neither is set, the stack file's `auditCmd.absenceSignal` fires with a `warning` so the user knows they need to configure the scheme.

`swiftlint` is used when present; absence is reported through `lintCmd.absenceSignal: warning`. iOS projects without lint configured continue to function.

### auditCmd

```yaml
auditCmd:
  command: "swift package show-dependencies --format json"
  fallback: "pod outdated"      # for CocoaPods projects
  absenceSignal: warning
  absenceMessage: "No SwiftPM or CocoaPods dependency manifest detected; manual audit required."
```

A real CVE-checking pipeline for SwiftPM is not as standardised as `npm audit` or `pip-audit`. v1 reports the dependency surface; future revisions can integrate with services like SwiftPM-Index or Sonatype OSS Index when those become reliable.

### cacheEnv

```yaml
cacheEnv:
  - envVar: DERIVED_DATA
    valueTemplate: "<worktree>/.gan-cache/derived-data"
  - envVar: SWIFTPM_CACHE
    valueTemplate: "<worktree>/.gan-cache/swiftpm"
```

Per-worktree DerivedData prevents Xcode lock contention when two worktrees of the same project build concurrently.

### securitySurfaces

```yaml
securitySurfaces:
  - id: keychain_usage
    template: "Sensitive data uses Keychain Services (`SecItemAdd`/`SecItemCopyMatching`), never `UserDefaults` or plain `FileManager`."
    triggers:
      keywords: ["UserDefaults", "Keychain", "kSecClass", "SecItem"]

  - id: ats_exceptions
    template: "`NSAppTransportSecurity` exceptions in Info.plist are explicitly justified per host; `NSAllowsArbitraryLoads` is not enabled in production builds."
    triggers:
      scope: ["**/Info.plist"]
      keywords: ["NSAppTransportSecurity", "NSAllowsArbitraryLoads", "NSExceptionDomains"]

  - id: url_scheme_handling
    template: "Inbound `URL` handlers (CFBundleURLTypes, `application(_:open:options:)`) validate and sanitise input before dispatching to app code."
    triggers:
      scope: ["**/Info.plist", "**/AppDelegate.swift", "**/SceneDelegate.swift", "**/*App.swift"]
      keywords: ["CFBundleURLTypes", "application(_:open:", "scene(_:openURLContexts:"]

  - id: universal_links
    template: "Associated Domains entitlements declaring `applinks:` match a published `apple-app-site-association` for the corresponding host; inbound `NSUserActivity` paths validate input before use."
    triggers:
      scope: ["**/*.entitlements", "**/AppDelegate.swift", "**/SceneDelegate.swift", "**/*App.swift"]
      keywords: ["com.apple.developer.associated-domains", "applinks:", "NSUserActivity"]

  - id: biometric_auth
    template: "`LAContext` evaluations fall back safely on policy-evaluation failure; biometric prompts include a `localizedReason` and the failure path does not silently authenticate the user."
    triggers:
      keywords: ["LAContext", "evaluatePolicy", "deviceOwnerAuthentication"]

  - id: app_signing
    template: "Release builds use a Distribution signing certificate; entitlements match the bundle identifier; `CODE_SIGN_STYLE` is `Manual` for release configurations or signing settings are pinned in CI."
    triggers:
      scope: ["**/*.xcodeproj/project.pbxproj", "**/*.xcconfig"]
      keywords: ["CODE_SIGN_STYLE", "DEVELOPMENT_TEAM", "PROVISIONING_PROFILE"]

  - id: data_protection
    template: "Files containing user data declare an appropriate `NSFileProtection` class (`Complete`, `CompleteUntilFirstUserAuthentication`, or `CompleteUnlessOpen`); unprotected files are justified."
    triggers:
      keywords: ["NSFileProtection", "FileProtectionType", "Data.WritingOptions"]

  - id: webview_origin
    template: "`WKWebView` instances restrict navigation to known origins via `WKNavigationDelegate`; `addUserScript` callers gate cross-origin scripts."
    triggers:
      keywords: ["WKWebView", "WKWebViewConfiguration", "WKUserContentController", "addUserScript"]
```

### conventions

Free-form prose section (per C1's markdown body split). Optional and hand-edit-only. A first-time project can leave it empty; teams document their iOS-specific conventions here for the planner to read as context.

## Acceptance criteria

- A minimal iOS app with `*.xcodeproj` declaring an iOS SDK target activates `stacks/ios.md`.
- A bare `Package.swift` without `.iOS(` in `platforms:` does not activate `stacks/ios.md`; it falls through to `stacks/generic.md`.
- A polyglot Swift+Node monorepo activates both `stacks/ios.md` and `stacks/web-node.md`; security surfaces from each apply only to their own scope (per C2's scope filtering).
- The contract-proposer instantiates at least the `keychain_usage` and `ats_exceptions` surfaces for a sprint that introduces `UserDefaults` writes or modifies `Info.plist`.
- `xcodebuild` failures are reported as build-phase failures distinct from test or lint failures (per C1's separated phase fields).
- `cacheEnv` for `DERIVED_DATA` and `SWIFTPM_CACHE` resolves correctly per F1's zone 3 conventions; concurrent runs in different worktrees do not lock-contend.
- An iOS project without a configured scheme produces a clear warning on first run, naming the missing config in `.claude/gan/modules/ios.yaml` (or pointing at where to declare it).
- The stack file validates against `schemas/stack-vN.json` published per F3.

## Dependencies

- C1 (stack plugin schema)
- C2 (detection / dispatch with scope filtering)
- F1 (zone 3 for DerivedData and SwiftPM cache)
- R1 (the API serves the stack file to agents)

## Bite-size note

Sprintable as: detection composite + scope first → buildCmd/testCmd + cacheEnv → security surfaces in two batches (storage/transport then signing/data-protection) → polyglot fixture + acceptance tests. The security-surface set is large; landing it in halves makes review tractable.

A future `src/modules/ios/` may automate scheme/destination resolution; out of scope for v1 of this stack file.
