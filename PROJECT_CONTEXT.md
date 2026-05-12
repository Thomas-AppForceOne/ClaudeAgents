# Project context

_Last verified: 2026-05-12. Phases 0–4 shipped (F1–F4, C1–C5, R1–R5, E1–E3, M1–M3). v1.0 work in flight: I1 (PR #9), I3 (PR #9 + #10), I2 (PR #13) merged to `develop`. F5 next per `specifications/roadmap.md`._

ClaudeAgents is a generator-discriminator framework for AI-driven software development. The architectural spine (Phases 0–4) has shipped; v1.0 work continues on `develop` per the roadmap's implementation order. Single-writer rule: only spec-validator writes this file; other agents read.

This file is authoritative for **conventions** (how we work). `specifications/roadmap.md` is authoritative for **order** (what comes next). Each spec file is authoritative for **what its spec governs**.

## Platform priority

- **v1 target platform: macOS.** UX, error-text discipline, and bash compatibility (3.2 floor) all assume macOS as the primary user environment. Release-gating tests run on macOS.
- **Linux:** supported best-effort. Failures are bugs to fix when reported but do not gate releases. Most code paths (POSIX file modes, symlinks, `realpathSync.native`, sync IO, bash 3.2-compatible scripts) work identically on modern Linux; macOS-specific bash 3.2 constraints are a strict superset of what Linux bash handles.
- **Windows:** explicitly out-of-scope for v1. Symlink permissions, path-separator differences, file-mode semantics, and bash availability all diverge enough that committing to Windows would multiply v1 surface area substantially without clear demand. The framework may happen to function on Windows in some configurations but that is not a property the project commits to or tests for.
- **Macos-coupled UX rules are load-bearing and stay:** the iOS-developer-on-macOS readability check for user-facing error text, the no-`npm`/`Node` discipline in user-facing strings, and the bash-3.2 floor in `install.sh` follow from this priority and do not change.

## Tech stack

- **Spec authoring:** Markdown only. Specs live under `specifications/` with phase-coded filenames. Phase codes: F (foundation), C (configuration), R (reference implementation), E (agent integration), M (modules), U (user-facing extensibility), O (observability), I (install), D (diagnostics), H (hooks), W (warnings), A (agent safety), T (telemetry), V (LLM-verdict verification), B (benchmarks), Q (quality signal), S (deferred ecosystem stacks).
- **Runtime tooling (R1-locked):**
  - **Node engine:** `>=20.10.0` (no upper bound; tested-through ceiling lives in `install.sh`'s `TESTED_THROUGH_NODE_MAJOR` constant per I3, currently `25`).
  - **Language:** TypeScript with real build step (`tsc -> dist/`); the published package is consumed by E1 / R3 / R4.
  - **Module system:** ESM (`"type": "module"`).
  - **Test runner:** vitest (ESM-first, fast, modern).
  - **Linter:** eslint + `@typescript-eslint`.
  - **Formatter:** prettier.
  - **Type-checker:** `tsc --noEmit` in CI.
  - **Pinned majors:** `@modelcontextprotocol/sdk@^1.29.0`, `picomatch@^4`, `ajv@^8`.
  - Distributed via npm. R3 CLI wrapper and R4 maintainer scripts share this toolchain.
- **Package identifiers (R1-locked):**
  - Package name: `@claudeagents/config-server`.
  - Bin name: `claudeagents-config-server`.
- **Installer (R2-locked):** Bash (`install.sh`). Covers install + uninstall + the I2 permission-consent flow.
  - **Install pattern:** local-install-only until the package is published — `npm install -g .` from the repo root (or `npm pack && npm install -g <tgz>`). Outside-repo registry fallback is a future task.
  - **`MCP_SERVER_VERSION` source of truth:** `install.sh` reads `package.json` at runtime via `node -p` (no hardcoded constant). A maintainer lint that pins the version-source pattern is an R4 follow-up.
  - **`~/.claude.json` + `~/.claude/settings.json` write rules:** single backup per machine before the first edit; JSON manipulation via `node -e` (no `jq` dependency); atomic temp-file + rename with sorted-key + two-space-indent + trailing newline. Per-run preedit copies under STATE_LOG drive rollback on partial failure.
  - **Idempotency check pattern:** version-probe first (`claudeagents-config-server --version`); only run `npm install -g .` if the binary is missing or the version mismatches `package.json`. Re-runs of `configure_permissions` skip categories whose tools are all already in `permissions.allow` (I2 sprint 3b).
  - **Zones created by installer:** `.gan-state/` and `.gan-cache/` only. Zone 1 (`.claude/gan/`) is left alone (created lazily on first overlay authoring).
- **Bash testing pattern (R2-locked):** vitest + `child_process.spawn` shelling out to `install.sh`. Tests live under `tests/installer/`. No new CI workflow file (the installer rides the existing test harness).
- **CLI wrapper (R3-locked):**
  - **Bin name:** `gan` (registered in the existing `@claudeagents/config-server` package's `bin` map, alongside the existing `claudeagents-config-server`).
  - **Source:** `src/cli/` — entry at `src/cli/index.ts`, subcommand modules under `src/cli/commands/`, shared helpers (arg parser, JSON output, exit-code map, scaffold builder) under `src/cli/lib/`.
  - **Tests:** `tests/cli/` — vitest + `child_process.spawn` shelling out to the built `dist/cli/index.js` (same harness shape as `tests/installer/`). Unit tests for pure helpers (arg parser, scaffold builder) sit alongside under `tests/cli/lib/`.
  - **Backend integration:** R3 imports R1's library functions directly (per the dual-callable-surface rule). It does **not** spawn the MCP server as a subprocess — F2's contract treats the API as a function surface, and R1 already exports every read/write/validate function. The R3 spec's "Spawns the R1 server in CLI mode" wording is satisfied by the in-process library import: same code, different transport.
  - **Exit-code map** (locked, per R3 spec): `0` success / `1` generic failure / `2` validation failure (config issues with structured report on stdout) / `3` schema mismatch / `4` invariant violation / `5` API/server unreachable (R1 dependency missing) / `64` bad CLI arguments. Mapping from F2 structured-error `code` to exit code lives in one place (`src/cli/lib/exit-codes.ts`).
  - **`--json` semantics:** `--json` on a read subcommand emits the raw API response JSON (sorted keys, two-space indent, trailing newline per F3 determinism rule). On error, `--json` emits the F2 structured error object as JSON to stdout and exits with the mapped exit code; without `--json`, errors render as human-readable text on stderr. Help text is **always** human-readable; `gan --help --json` ignores `--json`.
  - **`--project-root` default:** the canonical form (per F2 path canonicalisation) of `process.cwd()`. Trust-mutating subcommands (R5) require `--project-root` explicitly — R3 surfaces the flag globally; the R5 commands enforce explicitness.
  - **Help-output rule:** all help (top-level + per-subcommand + bare `gan`) goes to stdout and exits 0; help text never references maintainer-only scripts (per the user-facing-error-text discipline).
  - **Scaffold owner:** `gan stacks new` builds the DRAFT-bannered scaffold via a single helper (`src/cli/lib/scaffold.ts`); the verbatim banner string and the per-field placeholder strings live there. R4's `lint-stacks` reads the same banner constant when implemented.
  - **No new CI workflow file:** R3 rides the existing test harness (same pattern R2 set).
  - **R3 does NOT own the trust subcommands:** `gan trust info|approve|revoke|list` are R5's territory (per `specifications/runtime-knobs.md`). R3 ships the bin and the dispatcher; R5 adds the trust subcommands as additional dispatch arms.
- **Schemas:** JSON Schema documents at `schemas/<type>-vN.json` (per F3). `stack-v1.json` (C1), `overlay-v1.json` (C3), `module-manifest-v1.json` (M1), `progress-v1.json` (O2), `api-tools-v1.json` (R1) are on disk. F3 is meta-only; concrete schemas are authored by their owning domain spec. v1.0 adds `run-trace-v1.json` + `run-trace-index-v1.json` (T1), `evaluator-evidence-bundle-v1.json` (T1), `telemetry-config-v1.json` + `telemetry-outcome-v1.json` (O3).
- **Branch strategy:** branches and worktrees cut from `develop`, named `feature/<spec-name>` after the spec they implement. Implementation merges back to `develop`; `develop` merges to `main` at release boundaries only.

## Architecture

- **Configuration API as black box.** Agents call named functions (`getResolvedConfig`, `validateAll`, `setOverlayField`, `registerModule`, …); they never parse files, know schemas, or enumerate tiers. F2 + R1 own the contract.
- **Three project zones with single-owner lifecycles** (F1):
  - `.claude/gan/` — config (zone 1, `/etc`-like, committed, hand-edited + sanctioned API writes).
  - `.gan-state/` — durable state (zone 2, `/var/lib`-like, gitignored, never hand-edited).
  - `.gan-cache/` — ephemeral cache (zone 3, `/var/cache`-like, gitignored, regenerable).
- **Three-tier overlay cascade** (C4): default → user (`~/.claude/gan/`) → project (`.claude/gan/`).
- **Stack files are data, not code.** Per-ecosystem behavior declared in `stacks/<name>.md`; modules under `src/modules/<name>/` pair by name (enforced at API registration time).
- **Trust model.** Committed overlays + arbitrary commands are an attack surface; F4/R5 specify a content-hash trust cache, an interactive prompt, and `--no-project-commands`.

## Code organization

- `specifications/` — the spec set. Authoritative; phase-coded filenames give natural execution order. Implementation order lives in `roadmap.md`.
- `specifications/deferred/` — authored-but-deferred S-series stack specs (Android, KMP, iOS Swift). Reactivation gated by criteria in `deferred/README.md`.
- `agents/` — `gan-planner.md`, `gan-contract-proposer.md`, `gan-contract-reviewer.md`, `gan-generator.md`, `gan-evaluator.md` (authored by E1, consumed by the orchestrator at sprint time).
- `skills/gan/` — `SKILL.md` (the orchestrator prompt) and `trust-prompt.md`.
- `install.sh` — covers install (R2 + I1 + I2 + I3) and uninstall.
- `README.md` — top-level overview.
- `src/config-server/` — R1 MCP server. Internal layout (R1-locked):
  - `tools/` — MCP tool wrappers (one file per public API function).
  - `storage/` — zone 1/2/3 file I/O.
  - `resolution/` — overlay cascade (C4) and stack file resolution (C5).
  - `invariants/` — one file per F3-cataloged cross-file invariant; single point of implementation (R4 imports, never re-implements).
  - `determinism/` — centralized determinism pins (picomatch glob, `realpathSync.native` canonicalisation, sorted-key JSON, locale-sensitive sort). No duplicate implementations elsewhere.
  - `logging/` — per-run log routing (`GAN_RUN_ID` env var routes to `.gan-state/runs/<id>/logs/config-server.log`; otherwise stderr).
  - `errors.ts` — error factory; every error code from F2's enum is built here, no inline error construction. Current code set: `SchemaMismatch`, `InvalidYAML`, `MissingFile`, `UnknownStack`, `UnknownSplicePoint`, `InvariantViolation`, `ValidationFailed`, `UnknownApiVersion`, `UntrustedOverlay`, `TrustCacheCorrupt`, `PathEscape`, `NotImplemented`, `MalformedInput`, `CacheEnvConflict`, `ModuleManifestInvalid`, `ModuleCollision`, `ModulePrerequisiteFailed`, `PlatformNotSupported`, `TimeoutError`, `PortInUse`, `PortNotDiscovered`, `UnknownStateKey`.
- `src/cli/` — R3 CLI wrapper (`gan` bin).
- `src/modules/<name>/` — runtime utility libraries (M1, M2; today: `docker`).
- `stacks/<name>.md` — repo-tier stack files (`web-node`, `generic`; E2-authored).
- `schemas/<type>-vN.json` — published JSON Schemas (F3, populated by R4's `publish-schemas`).
- `scripts/{lint-stacks,publish-schemas,evaluator-pipeline-check,pair-names,lint-no-stack-leak}/` — R4 maintainer tooling.
- `tests/config-server/{tools,resolution,invariants,integration}/` — R1 test layout (vitest).
- `tests/fixtures/stacks/` — fixture set: `js-ts-minimal/` (clean web-node), `synthetic-second/.claude/gan/stacks/synthetic-second.md` (multi-stack guard-rail seed), `polyglot-webnode-synthetic/` (polyglot).
- `.github/workflows/` — locked CI inventory (see "Testing").

## Testing

Tests run via vitest. CI is one workflow file per category:

- `test-modules.yml` — module-side unit/integration tests.
- `test-evaluator-pipeline.yml` — runs `scripts/evaluator-pipeline-check/` (E3 harness, deterministic core only, no LLM in CI).
- `test-stack-lint.yml` — runs `scripts/lint-stacks/`.
- `test-schemas.yml` — runs `scripts/publish-schemas/` in dry-run mode (drift check).
- `test-no-stack-leak.yml` — runs `scripts/lint-no-stack-leak/` (multi-stack guard rail).
- `test-error-text.yml` — error-message readability check (no Node/npm leaks into user-facing output).
- Plus a shared `shared-setup.yml` reusable workflow.

New test categories follow `test-<category>.yml`. The set is locked; expansion requires a coordinated edit. Current suite: ~95 test files, 800+ tests, all green on `develop`.

## Tooling

R1-locked toolchain for the `@claudeagents/config-server` package (and shared with R3/R4):

- **Linter:** eslint + `@typescript-eslint`.
- **Formatter:** prettier.
- **Type-checker:** `tsc --noEmit` (run in CI).
- **Test runner:** vitest.
- **Build:** `tsc -> dist/` (real build step; published package consumed by E1 / R3 / R4).

CI workflow inventory is locked (see Testing).

## Conventions

- **Phase-coded spec filenames** (`F1-…md`, `R4-…md`). Filenames carry execution order.
- **One spec ≈ one sprint** of focused work. Sprint-level slicing is noted in each spec's "Bite-size note".
- **Acceptance criteria can be deferred-by-design.** A spec may list ACs whose enforcement lands in a downstream spec; the wording must name the consuming spec and say "verified when X ships". F1's AC #1, #4, #6 are examples.
- **Specs reference [`specifications/runtime-knobs.md`](specifications/runtime-knobs.md)** rather than restating their own user-facing surfaces. New flags, env-var values, subcommands, or prompt branches land in `runtime-knobs.md` in the same PR that introduces them.
- **Schemas are the canonical inventory.** `schemas/<type>-vN.json` files (overlay, stack, run-trace, telemetry-*, evaluator-evidence-bundle, etc.) are the single source of truth for "what fields exist." A spec that introduces new fields, splice points, event classes, or error codes documents the *behaviour* of each new entry in its body, then lists the schema additions in a brief "Schema additions" section that names the entry and its shape (type, default, tier scope for splice points). The implementation PR lands the schema change. Specs do not maintain parallel field-inventory tables; readers cross-reference field shape via the schema, behaviour via the introducing spec.
- **The Retirement table is authoritative** for what dies when. An implementation PR that touches a row must show the named artifact as `D` or `M` in the diff. Survival blocks the merge.
- **Implemented specs are immutable.** Once a specification has shipped (implementation merged to `develop` and then released), no further edits to that spec's prose are accepted. Regressions, new ideas, refinements, or behaviour additions that touch a shipped spec's surface must be expressed in one of two ways: (1) author a wholly-new spec under the next free phase-coded slot, OR (2) fold the change into an unimplemented spec that already touches the same code. This rule applies to every shipped phase (F1–F4 from Phase 0, R1–R5 from Phase 2, E1–E3 from Phase 3, M1–M3 from Phase 4) and to every v1.0 spec the moment its implementation PR merges. Inline-amendment-to-shipped-spec is retired as a pattern.
  - **Why:** shipped specs are the contract the implementation already honours. Editing them after the fact creates a window where the spec describes behaviour the code doesn't yet match, and reviewers can no longer tell "what was always in the spec" from "what was added later." A new spec carries its own authoring discipline (problem statement, AC, dependencies) and its own implementation PR; an inline amendment short-circuits both.
  - **Effect on cross-spec references:** the roadmap stays the cross-reference layer. A reader of F2 looking for cache-coherence behaviour will not find it in F2 — they find F5 via the roadmap entry, which is authoritative.
  - **Effect on dependencies:** a new spec that builds on a shipped spec's foundation lists the shipped spec under "Dependencies" but does not propose edits to it.
  - **Exception path:** none for normal work. A truly-broken contract in a shipped spec (e.g. F2's `setOverlayField` signature describes behaviour the code never actually had) is a `BUG` that the orchestrator may need to short-circuit around; the fix is still a new spec, not an edit to the shipped one. The orchestrator's behaviour in the interim window is captured in a follow-up spec, not by quietly correcting the spec it was supposed to honour.
- **Schema discipline tightens at v1.0 cut.** Pre-v1.0, any schema change bumps `schemaVersion`; no backward-compatibility shims, no transitional dual-path windows. From v1.0 onward: additive changes (new optional fields, new discriminator values within an existing event class, new event classes) stay on `vN`; field-rename or semantic-change forces `vN+1` with release-note treatment.
- **Release-driven from v1.0 forward.** Specs whose design quality depends on real-world usage data (V/B benchmarks, Q-series quality signal, T3 budget ceilings, A2 glob granularity, Q2 error-code vocabulary) are deliberately deferred to the release whose dogfooding produces that data. Pre-building them on speculation produces a worse spec set than waiting for signal.
- **Spec-vs-shipped status markers.** Specs that describe forward-looking behaviour (orchestrator skill flows, agent prompts, multi-stage feature rollouts) carry per-section status markers: `[shipped-in-v<release>]` (operative now), `[deferred-to-v<release>]` (described for forward-compat, not yet operative), `[partial-v<release>]` (minimal viable shipped, full version in a later release). Without markers, an implementer reading the spec from scratch has no signal that some sections describe aspirational behaviour the runtime can't yet deliver.
- **Five-question relevance filter for new capabilities.** Any proposed primitive, splice point, runtime knob, or agent-surface addition is triaged against five questions before it earns a spec slot:
  1. Does it plug into the framework's existing primitives (Configuration API, stacks, overlays, modules, hooks, trace), or does it reach around them?
  2. Can other agents, plugins, or future specs build on top of it without re-implementing its logic? (composability test)
  3. Does it own or access durable, structured state (zone 2 artifacts, configuration, trace), or is it ephemeral chat-style behaviour?
  4. Does it fit existing ecosystem boundaries (stack/module pairing, three-zone discipline, three-tier overlay cascade, schema-versioning rules), or does it require carving a new ownership lane?
  5. Can it be stacked or composed with other capabilities, or is it a terminal feature whose use case is exhausted by its first invocation?

  A proposal that fails three of the five is a feature, not infrastructure. Features are not rejected — they are deferred until either the failing dimensions are closed by other infrastructure work, or release-driven dogfooding shows the feature compounds into something more general. New specs include the answers in their "Problem" section; reviewers use the answers to challenge whether the work belongs in this release or a later one.

## Do's and don'ts

**Do:**
- Maintain the **single-canonical-stack** rule: one stack file per ecosystem at the repo tier; users fork into project tier to diverge.
- Treat the work as **replacement, not migration**: extract content from old prompts, replace wholesale, delete old artifacts in the same PR.
- Honor **retirement discipline**: no lingering legacy. Every retired artifact dies in the PR that supersedes it.
- Honor the **multi-stack guard rail**: synthetic-second fixture stack + `lint-no-stack-leak` + cross-stack capability assertion in E3 must all stay green.
- Honor the **black-box API rule**: agents call functions, never parse files. New code paths that read `.claude/gan/` directly from agent prompts are a regression.
- Honor the **single-writer rule** for `PROJECT_CONTEXT.md` (project root): only spec-validator writes; other agents read.
- Use **Node 20.10+ for maintainer tooling and the installer prereq check** (matches `package.json` engines). End-user experience on non-Node ecosystems must never require Node at runtime.
- Honor the **user-facing error-text discipline** (per F4): every user-visible string from the agent, CLI, prompts, or error paths must (a) use shell remediation (`rm <path>`) not Node remediation (`npm run …`), (b) refer to "the framework" or "ClaudeAgents" — never "the Node MCP server" or "the npm package", and (c) pass an iOS-developer-on-macOS readability check (a Swift dev who only ran `install.sh` should understand every word). `test-error-text.yml` is the CI backstop; reviewers flag leaks in PRs that touch user-visible output.
- Honor the **overlay catalog rule** (per C3): C3's splice-point table is the single source of truth for every overlay splice point — its shape, default, tier-allowance, and merge rule. C4 (cascade narrative), O1 (`mergedSplicePoints`), and U1 / U2 (UX) reference C3's catalog rather than restating fields. Adding a new splice point means editing C3's table (and C4's narrative if needed) — never editing UX prose to keep specs consistent. The catalog assumes splice points resolve **independently** (no cross-splice-point conditional rules); a future splice point requiring such coupling needs its own spec section justifying the deviation.
- Honor the **`discardInherited` two-form rule** (per C3): the flag accepts two encodings — block-level (`{block}.discardInherited: true` sibling to splice points; drops every upstream value in that block) and field-level (`{field}: { discardInherited: true, value: <original-value> }`; drops upstream for that single field only). `discardInherited: false` is valid and equivalent to omission. Field-level wins over block-level when both are set (more-specific wins). `discardInherited: true` without a `value` resets the field to its default. An unknown `{discardInherited, value}` wrapper on a field that doesn't accept the structured form is a hard error. This applies uniformly to project and user overlays; only the merge target differs (per C4).
- Honor the **schema-vs-tier separation** (per C3 + F3): JSON Schema documents validate **shape** only. Cross-file invariants — including which tier may declare which fields (e.g. user-overlay-forbidden `additionalContext`, `stack.override`, `stack.cacheEnvOverride`) — live in R1's invariant catalog (per F3) and are enforced by R1's tier-aware loader, not by the schema. The schema permits these fields unconditionally; the tier gate is upstream. F3's `overlay.tier_apiVersion`, `cacheEnv.no_conflict`, `additionalContext.path_resolves`, and `path.escape` invariants apply to overlays at validation time.
- Honor the **dispatch invariants** (per C2): (a) **active-set union** — multiple matching stacks all activate; the API exposes the union of their fields; (b) **scope-filtered rule application** — union applies to *which* stacks are active, not *how* their rules apply; stack-scoped fields (`securitySurfaces`, `auditCmd`, `secretsGlob`, `lintCmd`, `testCmd`, `buildCmd`) evaluate only against files inside that stack's `scope` (no cross-contamination across ecosystems); (c) **empty `stack.override` after cascade = run auto-detection** (never "force active set empty"); (d) `stack.override` is **all-or-nothing** — never additive to detection; (e) **dispatch fails closed** — malformed stack files, schemaVersion mismatch, invalid detection globs, cacheEnv conflicts, and overlays referencing unknown stacks all halt the run with a clear message; empty-scope-after-activation is a *warning*, not an error.
- Honor the **cascade invariants** (per C4): (a) **higher tier wins** — direction is project > user > default; on scalar conflicts the leaf-most defined value replaces lower tiers; on list merges, lower-tier entries appear first and higher-tier entries append after, preserving order; (b) **duplicate-key positioning** — when a higher-tier entry overrides a lower-tier entry by key (e.g. same `name` in `additionalCriteria`, same `command` in `additionalChecks`), the overriding entry takes the **lower-tier slot's position**, not the appended position; new entries from the higher tier append after, in the higher tier's source order (no sorting, no interleaving). Worked rule: lower `[A,B,C]` + higher `[X,B',Y]` resolves to `[A,B',C,X,Y]`. This is execution order for command lists; consumers may rely on it; (c) **discard-then-empty fallback** — `discardInherited: true` with no replacement value falls back to the agent's bare default (per C3's catalog), never to "unset" or "undefined"; field-level `discardInherited` wins over block-level when both are set (more-specific wins); (d) **per-splice-point rules live in C3**, not C4 — C4 specifies cascade *mechanics* (how rules apply across tiers); the per-field merge rule (union-by-string, union-by-key, scalar-override, project-only, deep-merge) is read from C3's catalog. Implementation is one function in R1 (`resolveCascade()`); ACs are verified there.
- Honor the **stack-file-resolution invariants** (per C5): (a) **three tiers, highest wins** — `.claude/gan/stacks/<name>.md` (project) > `~/.claude/gan/stacks/<name>.md` (user) > `<repo>/stacks/<name>.md` (built-in). Same priority direction as C4's overlay cascade, but a different artifact set; (b) **wholesale replacement, never merge** — a higher-tier stack file replaces the lower-tier file in full; omitted fields are *dropped*, not inherited. Users who want additive behavior must use overlays (C3), not shadow stacks; (c) **detection lives only in tier 3** — project and user tiers can override a stack's contents but cannot introduce new detection patterns. New stacks ship via project-tier file + `stack.override` in the project overlay (per C3); enforced by F3's `detection.tier3_only` invariant; (d) **resolution runs inside R1's stack loader**, never in agent code — agents call `getStack()` / `getActiveStacks()` and receive the resolved file's data. Tier provenance is recorded per active stack and exposed via `getResolvedConfig()` for O1's observability surface; (e) **`schemaVersion` mismatch is fatal** at the resolved (highest-priority) file, not silently downgraded. Consistent with F3's exact-match rule.
- Honor the **stack-vs-overlay asymmetry** (per C5): **stack files replace, overlays merge.** The asymmetry is load-bearing — stack files are structurally rich (composite detection trees, scope globs, surface arrays with keyword + glob triggers) where any merge semantics would be ambiguous; overlays are deliberately narrow splice points with documented merge rules per C3's catalog. The boundary rule for users: use an overlay splice point if one exists for the change you want; fork the stack file wholesale only when no splice point covers your need (always true for `detection`, `scope`, and structural command fields like `buildCmd`/`testCmd`/`lintCmd`). C3's catalog growing automatically narrows the must-fork surface — UX docs should reference C3's catalog rather than restating which changes need forking.
- Honor the **`pairs-with.consistency` shadowed-default error wording** (per C5): when a project-tier stack file shadows a canonical repo-tier file that the corresponding module's manifest pairs with, but the project-tier file omits `pairsWith`, the `pairs-with.js` invariant must emit the verbatim remediation hint specified in C5 (names the offending file, names the expected `pairsWith` value, offers two fixes: re-declare `pairsWith` *or* rename the file and force activation via `stack.override`). The general `pairs-with` invariant is owned by M1; this specific message string is owned by C5 and must be reproduced verbatim by R1's loader. Other `pairs-with` failure modes use M1's wording.
- Honor the **single-implementation rule for cross-file invariants** (R1-locked): every cross-file invariant has exactly one implementation under `src/config-server/invariants/` (one file per F3-cataloged invariant). R4 lint, build-time scripts, and any other caller import from there — never re-implement. R1 owns 8 of the 9 F3-cataloged invariants (all except `trust.approved`, which R5 owns):
  1. `pairs-with-consistency.ts` (M1 owns most wording; C5 owns the shadowed-default verbatim string).
  2. `cache-env-no-conflict.ts`.
  3. `additional-context-path-resolves.ts`.
  4. `path-escape.ts`.
  5. `overlay-tier-api-version.ts`.
  6. `stack-tier-api-version.ts`.
  7. `detection-tier3-only.ts`.
  8. `stack-no-draft-banner.ts` (testable via fixtures even before R3's `gan stacks new` exists).
- Honor the **error factory rule** (R1-locked): every error code from F2's enum is built via `src/config-server/errors.ts`. No inline error construction anywhere in the codebase.
- Honor the **dual-callable surface rule** (R1-locked): every public API function is callable both via the MCP tool wrapper (`src/config-server/tools/`) and via direct library import — same underlying function, never two implementations.
- Honor the **centralized determinism rule** (R1-locked): F3's determinism pins live in `src/config-server/determinism/` (picomatch glob, `realpathSync.native` path canonicalisation, sorted-key JSON, locale-sensitive sort). No duplicate implementations elsewhere. Changing a pin is still a coordinated edit across every dependent spec (see existing Don't on F3 pins).
- Honor the **per-key module-state rule** (M3-locked): every module-state write/read takes a `key: string` parameter validated against the manifest's `stateKeys` allowlist before any I/O. Each declared key persists to its own file at `.gan-state/modules/<name>/<key>.json`; there is no whole-blob `state.json`. An undeclared `key` on a write rejects with `ConfigServerError` whose `code === "UnknownStateKey"` and whose message names both the module and the offending key; an undeclared `key` on a read returns `null` (consistent with "no file"). A module whose manifest omits `stateKeys` cannot persist any state. `appendToModuleState` honours `duplicatePolicy: "error" | "skip" | "allow"` (default `"error"`) with the same semantics as `appendToOverlayField`/`appendToStackField`. `removeFromModuleState` removes by `entryKey: string` (matches map property name, or list-member `key` field); non-existent `entryKey` is a no-op `{mutated: false, reason: 'entry-not-found'}`. Pre-M3 `state.json` files in zone 2 are orphaned, never auto-migrated.
- Honor the **per-run log routing rule** (R1-locked): when `GAN_RUN_ID` is set, the config server routes logs to `.gan-state/runs/<id>/logs/config-server.log`; otherwise it logs to stderr. Implementation lives in `src/config-server/logging/`.
- Honor the **local-install-only rule** (R2-locked): until `@claudeagents/config-server` is published to npm, the installer uses `npm install -g .` from the repo root. Specs and docs do not promise a published-registry install path; the registry fallback is a future task.
- Honor the **version-pin source-of-truth rule** (R2-locked): `install.sh` reads `MCP_SERVER_VERSION` from `package.json` at runtime via `node -p`. No hardcoded version constant in the installer. R3/R4 maintainer scripts that need the version follow the same pattern; an R4 lint will enforce the source-of-truth pattern.
- Honor the **`~/.claude.json` safety rules** (R2-locked): (a) one backup per machine to `~/.claude.json.backup-<timestamp>` before the first edit, never per-run; (b) JSON manipulation via `node -e` only — no `jq` dependency; (c) atomic temp-file + rename for every write; (d) no Claude-running detection (restart-once is the contract).
- Honor the **JSON-manipulation pattern** (R2-locked, applies to R3/R4 too): shell scripts that read or write JSON use `node -e`. `jq` is not a dependency.
- Honor the **idempotency-via-version-probe rule** (R2-locked): before invoking `npm install -g .`, the installer probes `claudeagents-config-server --version` and only installs if the binary is missing or its version mismatches `package.json`. Re-running `install.sh` on an up-to-date machine is a no-op for npm.
- Honor the **bash-test pattern** (R2-locked): `install.sh` is tested via vitest + `child_process.spawn`. Tests live under `tests/installer/`. No new CI workflow file — the installer rides the existing test harness.
- Honor the **CLI-imports-library rule** (R3-locked): `gan` calls R1's library functions in-process via the package's main entry. It does not spawn `claudeagents-config-server` as a subprocess. R3's `bin` lives next to R1's bin in the same `package.json`; both are produced by the same `tsc` build.
- Honor the **CLI exit-code map** (R3-locked): every user-visible exit code maps from an F2 structured-error `code` (or "no error → 0") through one table in `src/cli/lib/exit-codes.ts`. New error codes added in F2 require a same-PR addition to the table; the default for unmapped error codes is `1` (generic failure) so new codes never accidentally surface as `0`.
- Honor the **CLI `--json` round-trip rule** (R3-locked): on read subcommands, `gan <cmd> --json` emits a single JSON document on stdout — sorted keys, two-space indent, trailing newline (per F3 determinism). On error, `--json` emits the F2 structured-error object as JSON on stdout (so `gan ... --json | jq` works in both success and failure paths). Without `--json`, success renders human-readable on stdout, errors render on stderr.
- Honor the **scaffold-banner verbatim rule** (R3-locked): the DRAFT banner emitted by `gan stacks new` is a single canonical constant at `src/cli/lib/scaffold.ts`. R1's `stack-no-draft-banner` invariant and R4's `lint-stacks` both import the same constant; nobody hand-types the banner string. Its format: `# DRAFT — replace TODOs and remove this banner before committing.` followed by the explanatory line shown in R3's spec body. Any text change is a coordinated edit across R1 + R3 + R4 (and the existing `tests/fixtures/stacks/invariant-stack-draft-banner/` fixture).
- Honor the **no-detection-inference rule** (R3-locked): `gan stacks new` does not inspect the host repo to guess `detection`, `scope`, or any other ecosystem-specific field. It writes TODO placeholders only. "Smart" inference is explicitly out of scope (per R3's scaffold-contract discipline).
- Honor the **scaffold-no-overwrite rule** (R3-locked): `gan stacks new <name>` exits non-zero with a clear message if the target file already exists. The user must delete it first; the CLI does not expose a `--force` flag in v1.
- Honor the **module manifest-format rule** (M1-locked): module manifests are `manifest.json` (JSON, not YAML). They validate against `schemas/module-manifest-v1.json`. M2's spec body still shows YAML for *project-config* (`.claude/gan/modules/<name>.yaml`) — that distinction is intentional: project config is YAML for human edits; manifests are JSON for machine validation alongside the rest of the schema set.
- Honor the **module test-runner rule** (M1/M2-locked): module tests use **vitest** (matches the project-wide test runner per R1/R2/R3). M2's spec body says `node --test`; that line is overridden — every test under `tests/modules/<name>/` runs via vitest. Do not introduce `node:test` as a second test runner.
- Honor the **module-config schema minimal-now-extend-later rule** (M1-locked): each per-module config schema (`schemas/module-config-<name>-vN.json`) covers exactly the fields the module's spec documents at ship time, with no speculative additions. Future fields ship as a `vN+1` bump (per F3's exact-match + immutable-once-published rules), not as additive edits to the published schema. M2's `module-config-docker-v1.json` therefore covers only `containerPattern`, `fallbackPort`, `healthCheck.{path, expectStatus, timeoutSeconds}` — anything else is a v2.
- Honor the **soft-OK `pairsWith` rule** (M1-locked): the `pairs-with-consistency` invariant treats the case where a stack file *omits* `pairsWith` while a module declares `pairsWith: <stackName>` as a **soft-OK** (success with no error). Rationale: stacks may legitimately exist without knowing about every module that pairs to them (modules can be added to the framework after a stack is canonicalised), and forcing every stack to enumerate paired modules creates a back-reference graph the architecture deliberately avoids — pairing is a one-way declaration *from* the module *to* its stack. The invariant fires only when both sides declare `pairsWith` and they disagree, or when a stack's `pairsWith` references a module that doesn't exist (per M1's existing rules). The shadowed-default case (per C5) remains a hard error with verbatim wording. The invariant comment in `src/config-server/invariants/pairs-with-consistency.ts` documents this asymmetry.

**Don't:**
- Don't introduce backward-compatibility shims or transitional dual-path windows. Pre-1.0; schema changes bump `schemaVersion` and break.
- Don't accept `schemaVersion` ranges, graceful-downgrade reads, or forward-compat reads anywhere. F3's rule is **exact match**; mismatches return `SchemaMismatch`. Any additive change still bumps the version pre-1.0.
- Don't mutate a published schema document. Schemas are **immutable once published**; bumping means writing `<type>-v<N+1>.json` and updating consumers in lockstep. The bumping PR also lands the migration tool (`gan migrate-overlays --to=N+1`) — migration tooling is deferred to the first bump, not authored speculatively.
- Don't re-implement a cross-file invariant check in R4 lint or any other build-time path. **Single point of implementation:** R1 owns the check function; every other caller imports it. The invariant catalog in F3 is the authoritative list (currently 9 invariants spanning C1, C3, C5, U3, F4, M1, R3).
- Don't diverge from F3's determinism pins ad hoc. Glob = picomatch (pinned in R1's `package.json`); paths canonicalised via `fs.realpathSync.native` + trailing-slash strip + case-insensitive comparison; JSON output = sorted keys, two-space indent, trailing newline; file enumeration sorted via `localeCompare(other, undefined, { sensitivity: 'variant', numeric: false })`; regex = Node's V8 RegExp with Node engine pinned. Changing any pin is a coordinated edit across every dependent spec, plus `--update-goldens` and an R5 trust-cache invalidation.
- Don't write to zone 1 (`.claude/gan/`) outside the F2 sanctioned write channels.
- Don't let `/gan` per-run state bleed into `.claude/gan/` or `.gan-cache/`.
- Don't merge to `main` outside release boundaries. `develop` is the integration branch; `main` only carries tagged releases.
- Don't add ecosystem-specific tokens (`npm`, `gradle`, `pip-audit`, etc.) outside their owning stack file or an allowlisted path. `lint-no-stack-leak` is the permanent backstop.
- Don't expand the runtime-knob surface count without editing [`specifications/runtime-knobs.md`](specifications/runtime-knobs.md) in the same PR.
- Don't author new top-level project directories for gan data without amending F1 first.

## Known gaps

Open items at the time of this verification:

- **No CI test for end-to-end orchestrator flow.** v1.0 dogfooding is the implicit test surface for the SKILL.md → agent-spawn → snapshot → re-snapshot path. The orchestrator-side test harness is v2.0's V1 scope.
- **Per-stack overlay command override is a no-op.** Project overlays attempting to override a stack's `auditCmd` / `buildCmd` / `testCmd` / `lintCmd` silently no-op (see `reads.ts:329–332`). W1 surfaces a `PerStackOverrideUnsupported` warning so the gap is visible; full implementation lands in v1.1.
- **F5, F6, R6 spec files don't exist on disk yet.** Authored as part of v1.0 implementation order slots 5–7. F5 is in flight on the current branch.
