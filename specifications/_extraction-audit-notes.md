# Extraction audit notes — legacy prompts -> data files

_Working draft for the Sprint 6 PR body. Enumerates every stack-specific concept presently embedded in `agents/gan-evaluator.md`, `agents/gan-contract-proposer.md`, and `agents/gan-planner.md`, and records its destination._

## Destination tags

| Tag | Meaning |
|---|---|
| `web-node` | Lifted into `stacks/web-node.md`. |
| `generic` | Lifted into `stacks/generic.md` as a universal surface. |
| `proposer-template` | Conceptually a `securitySurfaces[].template` slot — instantiated by the evaluator at runtime per C1. In this repo any such concept is realised inside one of the two shipped stack files (see the per-row tag for which one it ended up in). |
| `dropped` | Explicitly retired. The new model does not ship a stack for this ecosystem; there is no shadow extraction destination. |

## Per-token table

| Source token | Source file(s) | Destination | Rationale |
|---|---|---|---|
| `npm audit` | `agents/gan-evaluator.md` line 147; `agents/gan-contract-proposer.md` line 75; `agents/gan-generator.md` line 103 | `web-node` | Becomes `auditCmd.command` (`npm audit --audit-level=high`) on the web-node stack. The evaluator no longer hard-codes per-ecosystem audit invocation; the active stack supplies the command. |
| `pip-audit` | `agents/gan-evaluator.md` line 148; `agents/gan-contract-proposer.md` line 75 | `dropped` | Python ecosystem is not in scope for the v1 shipped stack set. The deferred `python-*` stack spec under `specifications/deferred/` will reintroduce `pip-audit` when reactivated. |
| `cargo audit` | `agents/gan-evaluator.md` line 149; `agents/gan-contract-proposer.md` line 75 | `dropped` | Rust ecosystem is not in scope for the v1 shipped stack set. No deferred Rust stack spec exists; reactivation requires a new specification. |
| `govulncheck` | `agents/gan-evaluator.md` line 150; `agents/gan-contract-proposer.md` line 75 | `dropped` | Go ecosystem is not in scope for the v1 shipped stack set. No deferred Go stack spec exists. |
| `bundle audit` | `agents/gan-evaluator.md` line 151 | `dropped` | Ruby ecosystem is not in scope for the v1 shipped stack set. No deferred Ruby stack spec exists. |
| `gradle` | implied by JVM/Kotlin discussion; no current text token | `dropped` | JVM / Android / Kotlin ecosystems live under `specifications/deferred/` (Android, KMP). Gradle command lifting is gated on those S-series specs reactivating; the v1 shipped set does not include a JVM stack. |
| `kt` | (Android / KMP deferred specs only) | `dropped` | Kotlin source extension. Lifting destination would be a future `android` or `kmp` stack file; not in v1. |
| `kts` | (Android / KMP deferred specs only) | `dropped` | Kotlin script extension. Same disposition as `kt`. |
| `pip` | `agents/gan-evaluator.md` line 148; `agents/gan-contract-proposer.md` line 75 | `dropped` | Python toolchain. Same disposition as `pip-audit`. |
| `safety check` | `agents/gan-evaluator.md` line 148 | `dropped` | Alternate Python audit tool. Disposition follows `pip-audit`. |
| TLS (HTTPS for credentials/PII) | `agents/gan-generator.md` line 92; `agents/gan-contract-proposer.md` line 71; `agents/gan-planner.md` line 72 | `web-node` | Lifted into `web-node.md` `securitySurfaces[].id = tls_required_for_sensitive_traffic`. Triggers on `http://`, `fetch(`, `createServer`, etc. |
| CORS (no permissive `*`) | `agents/gan-generator.md` line 107; `agents/gan-contract-proposer.md` line 77 | `web-node` | Lifted into `securitySurfaces[].id = cors_not_wide_open`. Surface fires on `Access-Control-Allow-Origin`, `cors(`, `origin: "*"`. |
| Session / cookie flags (httpOnly, secure, SameSite) | `agents/gan-evaluator.md` line 164; `agents/gan-generator.md` line 88 | `web-node` | Lifted into `securitySurfaces[].id = session_cookie_flags`. |
| HTTP route input validation | `agents/gan-evaluator.md` lines 156–159; `agents/gan-contract-proposer.md` line 63 | `web-node` | Lifted into `securitySurfaces[].id = http_route_input_validation`. Triggers on `req.body`, `req.query`, `req.params`. |
| Shell / subprocess injection safety | `agents/gan-generator.md` line 81 | `web-node` | Lifted into `securitySurfaces[].id = shell_and_subprocess_safety`. Triggers on `child_process`, `exec(`, `spawn(`. |
| Prototype pollution | implicit in the polyglot fixture's surface set | `web-node` | Lifted into `securitySurfaces[].id = prototype_pollution` to match the existing fixture coverage. |
| Secrets globs (js, ts, json, env) | `agents/gan-evaluator.md` line 139; `agents/gan-generator.md` line 75 | `web-node` (js/ts/jsx/tsx/mjs/cjs/json/env) and `generic` (env only) | Web-node owns the JS-family extensions plus `json`/`env`; the universal `env` token is the only entry on the conservative `generic.md`. |
| Generic "secrets must not be committed" | `agents/gan-evaluator.md` lines 137–143; `agents/gan-contract-proposer.md` line 67 | `generic` and `web-node` | Universal surface lives on `generic.md`; `web-node.md` carries a JS-flavoured variant (`secrets_not_committed`) so the evaluator's web-stack template targets `**/*.json` and `**/*.env` specifically. |
| Generic input validation | `agents/gan-contract-proposer.md` line 63; `agents/gan-generator.md` line 79 | `generic` | Surface `untrusted_input_handling` on `generic.md`. The web-stack-specific HTTP variant is on `web-node.md`. |
| Error-message hygiene | `agents/gan-evaluator.md` lines 167–168; `agents/gan-generator.md` line 97 | `generic` | Surface `error_message_hygiene` on `generic.md`; applies regardless of ecosystem. |
| Secure defaults (no debug endpoints, no default creds, no world-readable secrets) | `agents/gan-evaluator.md` lines 170–173; `agents/gan-generator.md` line 107; `agents/gan-contract-proposer.md` line 77 | `generic` (universal) and `web-node` (CORS specialisation) | Generic surface `secure_defaults` covers the cross-ecosystem rule; the wide-CORS specialisation lives on `web-node.md`. |
| Cryptography correctness (no MD5/SHA-1, no ECB, no homebrew crypto) | `agents/gan-contract-proposer.md` line 81; `agents/gan-generator.md` lines 93–94 | `dropped` | The legacy prompt enumerated cryptography rules as a category. The v1 stack files do not ship a dedicated crypto surface — the rules apply at design-review time, not at evaluator-template time, and there is no per-ecosystem variation worth lifting. Re-evaluate when a stack ships that genuinely changes the available primitives. |
| Authentication & authorisation phrasing | `agents/gan-contract-proposer.md` line 65; `agents/gan-generator.md` lines 86–89 | `web-node` (cookie flags) and `dropped` (the rest) | The cookie-flag specialisation lives on `web-node.md`. The general "401 / 403, use a vetted library" guidance is left to spec authoring; it is not a stack-specific surface. |
| Logging hygiene (no PII / tokens in logs) | `agents/gan-generator.md` lines 98–99; `agents/gan-contract-proposer.md` line 73 | `dropped` | Universal but not template-shaped — there are no useful keyword triggers that would fire only on suspect logging without massive false-positive rates. Better expressed as a review-time rule than a templated surface. |
| Dependency pinning (no `^` / `~` ranges, commit lockfiles) | `agents/gan-generator.md` line 102 | `dropped` | The active project's lockfile policy is configured by the project itself, not by the framework's stack file. Surfacing this as a template would be noisy and generally not actionable from a single keyword trigger. |

## Notes

- The two shipped stack files (`web-node`, `generic`) are deliberately the only v1 surface. Every other ecosystem token in the legacy prompts maps to either `dropped` or a deferred S-series spec under `specifications/deferred/`.
- Where a concept appears on both `web-node.md` and `generic.md`, the table records the duplication explicitly. This is the asymmetry the new model relies on: `generic` carries the universal floor; ecosystem stacks carry the specialisation, and dispatch C2 unions both into the active set when they both match (which `generic` does only when nothing else matches).
- This audit is non-normative; the source of truth for what each shipped stack file declares is the stack file itself.
