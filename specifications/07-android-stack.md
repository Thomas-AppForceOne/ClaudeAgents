# 07 — Android stack

## Problem

Android is the first real test of the plugin system beyond the server/CLI world. Android-client concerns are meaningfully different from web-server concerns and cannot be captured by the built-in web stack:

- No server to spawn; "run the app" is compile + unit test + lint.
- Relevant security surfaces are client-side: certificate pinning, Network Security Config, `android:exported`, intent / deep-link validation, WebView JavaScript bridges, ProGuard/R8 keep rules, encrypted storage, keystore usage.
- `npm audit` has no analog without spec 02; even with it, the generated criteria come from the web checklist.

## Proposed change

Add `stacks/android.md` following the schema (04). Key contents:

- **detection**: `AndroidManifest.xml`, `build.gradle.kts` with `com.android.application` or `com.android.library` plugin applied.
- **secretsGlob**: `kt, kts, java, gradle, gradle.kts, xml, properties, env, json, yaml, yml`.
- **auditCmd**: delegate to `stacks/gradle.md` (activated by detection union, per spec 05); Android does not restate Gradle audit logic.
- **buildCmd**: `./gradlew assembleDebug`.
- **testCmd**: `./gradlew testDebugUnitTest`.
- **lintCmd**: `./gradlew lintDebug`.
- **securitySurfaces** — template criteria instantiated per spec 04's template-instantiation protocol. Each surface below lists its `triggers` so "touches the surface" is decidable without guesswork.
  - `exported_components` — template: "Activities/Services/Providers/Receivers with `android:exported=\"true\"` must validate caller identity or intent extras." Triggers: scope `**/AndroidManifest.xml`, `**/*Activity.kt`, `**/*Service.kt`, `**/*Provider.kt`, `**/*Receiver.kt`; keywords `android:exported`, `<activity`, `<service`, `<provider`, `<receiver`.
  - `deep_links` — template: "Intent filters accepting `http(s)` or custom schemes must validate and sanitise input before use." Triggers: scope `**/AndroidManifest.xml`; keywords `<intent-filter`, `android:scheme`, `android.intent.action.VIEW`.
  - `webview_js_bridge` — template: "`addJavascriptInterface` usage must gate methods with `@JavascriptInterface` and restrict the loaded origin." Triggers: keywords `addJavascriptInterface`, `WebView`.
  - `network_security_config` — template: "Release builds must pin certificates for known backend hosts or use a documented Network Security Config." Triggers: scope `**/AndroidManifest.xml`, `**/network_security_config.xml`, `**/OkHttp*.kt`, `**/Retrofit*.kt`; keywords `OkHttpClient`, `Retrofit`, `HttpsURLConnection`, `networkSecurityConfig`.
  - `keystore_usage` — template: "Cryptographic keys are stored in Android Keystore, never in SharedPreferences." Triggers: keywords `KeyStore`, `SharedPreferences`, `Cipher`, `KeyGenerator`.
  - `encrypted_storage` — template: "Sensitive data on disk uses `EncryptedSharedPreferences` or equivalent." Triggers: keywords `SharedPreferences`, `openFileOutput`, `FileOutputStream`, `Room.databaseBuilder`.
  - `proguard_r8` — template: "Release builds have minification/obfuscation enabled unless the spec explicitly justifies otherwise." Triggers: scope `**/build.gradle*`, `**/proguard-rules.pro`; keywords `minifyEnabled`, `isMinifyEnabled`, `proguardFiles`.

## Acceptance criteria

- A minimal Android project is detected as `android`.
- The contract-proposer generates at least the `exported_components` and `network_security_config` criteria for a sprint that introduces a new Activity or network client.
- The evaluator's dependency-audit pass uses the Gradle branch, sourced from `stacks/gradle.md` rather than restated in `stacks/android.md`.
- The evaluator's secrets grep catches a hardcoded API key in a `.kt` file — contributed by `stacks/kotlin.md` via the detection-union, not by Android restating Kotlin extensions.
- `stacks/android.md` contains no `runCmd` field; the three phases (build, test, lint) are reported as distinct evaluator signals.

## Dependencies

- 04, 05, 06, 02.

## Value / effort

- **Value**: high for any Android user; also validates whether the schema from 04 is expressive enough. If Android cannot be modelled cleanly, the schema needs revision.
- **Effort**: medium. The security-surface catalog needs careful authoring — too vague and criteria are untestable; too specific and they cease to be templates.
