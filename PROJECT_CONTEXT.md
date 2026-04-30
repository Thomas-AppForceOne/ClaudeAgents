# Project context

_Last verified: 2026-04-30 by spec-validator (C5 stack-file-resolution contract validation; no implementation)_

This repo is the RFC + implementation work for ClaudeAgents' "stack plugin" redesign. It is currently spec-only — implementation has not started. Phase 0 (foundations: F1–F4) is the first work to land.

## Tech stack

- **Spec authoring:** Markdown only. Specs live under `specifications/` with phase-coded filenames (F/C/R/E/M/U/O + S deferred).
- **Future runtime tooling:** Node 18+ (R1 MCP server, R3 CLI wrapper, R4 maintainer scripts). Distributed via npm. No package manifest yet.
- **Future installer:** Bash (`install.sh`). The current 138-line `.gan/`-based installer is legacy and will be rewritten in place by R2.
- **Future schemas:** JSON Schema documents at `schemas/<type>-vN.json` (per F3). None on disk yet. F3 is meta-only; concrete schemas are authored by their owning domain spec — `stack-v1.json` by C1, `overlay-v1.json` by C3, `module-manifest-v1.json` by M1. The `schemas/` directory is created when its first occupant lands.
- **Branch strategy:** Build on `feature/stack-plugin-rfc` through at least Phase 3. Do not merge to `main` mid-pivot. Merge gate is the post-E1 revision break (which also carries O2's prescriptive revision).

## Architecture

End-state architecture (not yet implemented):

- **Configuration API as black box.** Agents call named functions (`getResolvedConfig`, `validateAll`, `setOverlayField`, `registerModule`, …); they never parse files, know schemas, or enumerate tiers. F2 + R1 own the contract.
- **Three project zones with single-owner lifecycles** (F1):
  - `.claude/gan/` — config (zone 1, `/etc`-like, committed, hand-edited + sanctioned API writes).
  - `.gan-state/` — durable state (zone 2, `/var/lib`-like, gitignored, never hand-edited).
  - `.gan-cache/` — ephemeral cache (zone 3, `/var/cache`-like, gitignored, regenerable).
- **Three-tier overlay cascade** (C4): default → user (`~/.claude/gan/`) → project (`.claude/gan/`).
- **Stack files are data, not code.** Per-ecosystem behavior declared in `stacks/<name>.md`; modules under `src/modules/<name>/` pair by name (enforced at API registration time).
- **Trust model.** Committed overlays + arbitrary commands are an attack surface; F4/R5 specify a content-hash trust cache, an interactive prompt, and `--no-project-commands`.

## Code organization

Current working tree (legacy, mostly slated for retirement):

- `agents/` — five legacy agent prompts (`gan-planner.md`, `gan-contract-proposer.md`, `gan-contract-reviewer.md`, `gan-generator.md`, `gan-evaluator.md`). All retired in place by E1 (`M`).
- `skills/gan/` — legacy SKILL.md + a broken `gan` symlink + run-state JSON schemas. Retired by E1 (mix of `M` and `D`).
- `install.sh` — legacy `.gan/`-based installer. Rewritten in place by R2 (`M`).
- `README.md` — describes the legacy architecture. Rewritten in place by E1 (`M`).
- `specifications/` — the spec set. Authoritative. Phase-coded filenames give natural execution order.
- `specifications/deferred/` — authored-but-deferred S-series stack specs (Android, KMP, iOS Swift). Reactivation gated by criteria in `deferred/README.md`.

End-state directories (not yet created):

- `src/config-server/` — R1 MCP server.
- `src/modules/<name>/` — runtime utility libraries (M1, M2).
- `stacks/<name>.md` — repo-tier stack files (created by E2: `web-node` + `generic`).
- `schemas/<type>-vN.json` — published JSON Schemas (F3, populated by R4's `publish-schemas`).
- `scripts/{lint-stacks,publish-schemas,evaluator-pipeline-check,pair-names,lint-no-stack-leak}/` — R4 maintainer tooling.
- `tests/fixtures/stacks/` — fixtures including the synthetic-second multi-stack guard rail (R1 first slice).
- `.github/workflows/` — seven workflow files locked by the roadmap (see "Tooling").

## Testing

Test categories planned, none yet on disk. Each gets exactly one workflow file:

- `test-modules.yml` — module-side unit/integration tests.
- `test-evaluator-pipeline.yml` — runs `scripts/evaluator-pipeline-check/` (E3 harness, deterministic core only, no LLM in CI).
- `test-stack-lint.yml` — runs `scripts/lint-stacks/`.
- `test-schemas.yml` — runs `scripts/publish-schemas/` in dry-run mode (drift check).
- `test-no-stack-leak.yml` — runs `scripts/lint-no-stack-leak/` (multi-stack guard rail).
- `test-error-text.yml` — error-message readability check (no Node/npm leaks into user-facing output).
- Plus a shared `shared-setup.yml` reusable workflow.

New test categories follow `test-<category>.yml`. The set is locked by the roadmap; expansion requires roadmap edit.

## Tooling

Linter / formatter / type-checker choices are not yet picked — no Node code exists. R1 (Phase 2) is the first place this becomes a real decision; until then, defer.

CI workflow inventory is locked (see Testing).

## Conventions

- **Phase-coded spec filenames** (`F1-…md`, `R4-…md`). Filenames carry execution order.
- **One spec ≈ one sprint** of focused work. Sprint-level slicing is noted in each spec's "Bite-size note".
- **Acceptance criteria can be deferred-by-design.** A spec may list ACs whose enforcement lands in a downstream spec; the wording must name the consuming spec and say "verified when X ships". F1's AC #1, #4, #6 are examples.
- **Specs reference the roadmap's Runtime knobs table** rather than restating their own surfaces. New flags / env-var values land in the roadmap table in the same PR that introduces them.
- **The Retirement table is authoritative** for what dies when. An implementation PR that touches a row must show the named artifact as `D` or `M` in the diff. Survival blocks the merge.

## Do's and don'ts

**Do:**
- Maintain the **single-canonical-stack** rule: one stack file per ecosystem at the repo tier; users fork into project tier to diverge.
- Treat the work as **replacement, not migration**: extract content from old prompts, replace wholesale, delete old artifacts in the same PR.
- Honor **retirement discipline**: no lingering legacy. Every retired artifact dies in the PR that supersedes it.
- Honor the **multi-stack guard rail**: synthetic-second fixture stack + `lint-no-stack-leak` + cross-stack capability assertion in E3 must all stay green.
- Honor the **black-box API rule**: agents call functions, never parse files. New code paths that read `.claude/gan/` directly from agent prompts are a regression.
- Honor the **single-writer rule** for `PROJECT_CONTEXT.md` (project root): only spec-validator writes; other agents read.
- Use **Node 18+ for maintainer tooling only**. End-user experience on non-Node ecosystems must never require Node at runtime.
- Honor the **user-facing error-text discipline** (per F4): every user-visible string from the agent, CLI, prompts, or error paths must (a) use shell remediation (`rm <path>`) not Node remediation (`npm run …`), (b) refer to "the framework" or "ClaudeAgents" — never "the Node MCP server" or "the npm package", and (c) pass an iOS-developer-on-macOS readability check (a Swift dev who only ran `install.sh` should understand every word). `test-error-text.yml` is the CI backstop; reviewers flag leaks in PRs that touch user-visible output.
- Honor the **overlay catalog rule** (per C3): C3's splice-point table is the single source of truth for every overlay splice point — its shape, default, tier-allowance, and merge rule. C4 (cascade narrative), O1 (`mergedSplicePoints`), and U1 / U2 (UX) reference C3's catalog rather than restating fields. Adding a new splice point means editing C3's table (and C4's narrative if needed) — never editing UX prose to keep specs consistent. The catalog assumes splice points resolve **independently** (no cross-splice-point conditional rules); a future splice point requiring such coupling needs its own spec section justifying the deviation.
- Honor the **`discardInherited` two-form rule** (per C3): the flag accepts two encodings — block-level (`{block}.discardInherited: true` sibling to splice points; drops every upstream value in that block) and field-level (`{field}: { discardInherited: true, value: <original-value> }`; drops upstream for that single field only). `discardInherited: false` is valid and equivalent to omission. Field-level wins over block-level when both are set (more-specific wins). `discardInherited: true` without a `value` resets the field to its default. An unknown `{discardInherited, value}` wrapper on a field that doesn't accept the structured form is a hard error. This applies uniformly to project and user overlays; only the merge target differs (per C4).
- Honor the **schema-vs-tier separation** (per C3 + F3): JSON Schema documents validate **shape** only. Cross-file invariants — including which tier may declare which fields (e.g. user-overlay-forbidden `additionalContext`, `stack.override`, `stack.cacheEnvOverride`) — live in R1's invariant catalog (per F3) and are enforced by R1's tier-aware loader, not by the schema. The schema permits these fields unconditionally; the tier gate is upstream. F3's `overlay.tier_apiVersion`, `cacheEnv.no_conflict`, `additionalContext.path_resolves`, and `path.no_escape` invariants apply to overlays at validation time.
- Honor the **dispatch invariants** (per C2): (a) **active-set union** — multiple matching stacks all activate; the API exposes the union of their fields; (b) **scope-filtered rule application** — union applies to *which* stacks are active, not *how* their rules apply; stack-scoped fields (`securitySurfaces`, `auditCmd`, `secretsGlob`, `lintCmd`, `testCmd`, `buildCmd`) evaluate only against files inside that stack's `scope` (no cross-contamination across ecosystems); (c) **empty `stack.override` after cascade = run auto-detection** (never "force active set empty"); (d) `stack.override` is **all-or-nothing** — never additive to detection; (e) **dispatch fails closed** — malformed stack files, schemaVersion mismatch, invalid detection globs, cacheEnv conflicts, and overlays referencing unknown stacks all halt the run with a clear message; empty-scope-after-activation is a *warning*, not an error.
- Honor the **cascade invariants** (per C4): (a) **higher tier wins** — direction is project > user > default; on scalar conflicts the leaf-most defined value replaces lower tiers; on list merges, lower-tier entries appear first and higher-tier entries append after, preserving order; (b) **duplicate-key positioning** — when a higher-tier entry overrides a lower-tier entry by key (e.g. same `name` in `additionalCriteria`, same `command` in `additionalChecks`), the overriding entry takes the **lower-tier slot's position**, not the appended position; new entries from the higher tier append after, in the higher tier's source order (no sorting, no interleaving). Worked rule: lower `[A,B,C]` + higher `[X,B',Y]` resolves to `[A,B',C,X,Y]`. This is execution order for command lists; consumers may rely on it; (c) **discard-then-empty fallback** — `discardInherited: true` with no replacement value falls back to the agent's bare default (per C3's catalog), never to "unset" or "undefined"; field-level `discardInherited` wins over block-level when both are set (more-specific wins); (d) **per-splice-point rules live in C3**, not C4 — C4 specifies cascade *mechanics* (how rules apply across tiers); the per-field merge rule (union-by-string, union-by-key, scalar-override, project-only, deep-merge) is read from C3's catalog. Implementation is one function in R1 (`resolveCascade()`); ACs are verified there.
- Honor the **stack-file-resolution invariants** (per C5): (a) **three tiers, highest wins** — `.claude/gan/stacks/<name>.md` (project) > `~/.claude/gan/stacks/<name>.md` (user) > `<repo>/stacks/<name>.md` (built-in). Same priority direction as C4's overlay cascade, but a different artifact set; (b) **wholesale replacement, never merge** — a higher-tier stack file replaces the lower-tier file in full; omitted fields are *dropped*, not inherited. Users who want additive behavior must use overlays (C3), not shadow stacks; (c) **detection lives only in tier 3** — project and user tiers can override a stack's contents but cannot introduce new detection patterns. New stacks ship via project-tier file + `stack.override` in the project overlay (per C3); enforced by F3's `detection.tier3_only` invariant; (d) **resolution runs inside R1's stack loader**, never in agent code — agents call `getStack()` / `getActiveStacks()` and receive the resolved file's data. Tier provenance is recorded per active stack and exposed via `getResolvedConfig()` for O1's observability surface; (e) **`schemaVersion` mismatch is fatal** at the resolved (highest-priority) file, not silently downgraded. Consistent with F3's exact-match rule.
- Honor the **stack-vs-overlay asymmetry** (per C5): **stack files replace, overlays merge.** The asymmetry is load-bearing — stack files are structurally rich (composite detection trees, scope globs, surface arrays with keyword + glob triggers) where any merge semantics would be ambiguous; overlays are deliberately narrow splice points with documented merge rules per C3's catalog. The boundary rule for users: use an overlay splice point if one exists for the change you want; fork the stack file wholesale only when no splice point covers your need (always true for `detection`, `scope`, and structural command fields like `buildCmd`/`testCmd`/`lintCmd`). C3's catalog growing automatically narrows the must-fork surface — UX docs should reference C3's catalog rather than restating which changes need forking.
- Honor the **`pairs-with.consistency` shadowed-default error wording** (per C5): when a project-tier stack file shadows a canonical repo-tier file that the corresponding module's manifest pairs with, but the project-tier file omits `pairsWith`, the `pairs-with.js` invariant must emit the verbatim remediation hint specified in C5 (names the offending file, names the expected `pairsWith` value, offers two fixes: re-declare `pairsWith` *or* rename the file and force activation via `stack.override`). The general `pairs-with` invariant is owned by M1; this specific message string is owned by C5 and must be reproduced verbatim by R1's loader. Other `pairs-with` failure modes use M1's wording.

**Don't:**
- Don't introduce backward-compatibility shims or transitional dual-path windows. Pre-1.0; schema changes bump `schemaVersion` and break.
- Don't accept `schemaVersion` ranges, graceful-downgrade reads, or forward-compat reads anywhere. F3's rule is **exact match**; mismatches return `SchemaMismatch`. Any additive change still bumps the version pre-1.0.
- Don't mutate a published schema document. Schemas are **immutable once published**; bumping means writing `<type>-v<N+1>.json` and updating consumers in lockstep. The bumping PR also lands the migration tool (`gan migrate-overlays --to=N+1`) — migration tooling is deferred to the first bump, not authored speculatively.
- Don't re-implement a cross-file invariant check in R4 lint or any other build-time path. **Single point of implementation:** R1 owns the check function; every other caller imports it. The invariant catalog in F3 is the authoritative list (currently 9 invariants spanning C1, C3, C5, U3, F4, M1, R3).
- Don't diverge from F3's determinism pins ad hoc. Glob = picomatch (pinned in R1's `package.json`); paths canonicalised via `fs.realpathSync.native` + trailing-slash strip + case-insensitive comparison; JSON output = sorted keys, two-space indent, trailing newline; file enumeration sorted via `localeCompare(other, undefined, { sensitivity: 'variant', numeric: false })`; regex = Node's V8 RegExp with Node engine pinned. Changing any pin is a coordinated edit across every dependent spec, plus `--update-goldens` and an R5 trust-cache invalidation.
- Don't write to zone 1 (`.claude/gan/`) outside the F2 sanctioned write channels.
- Don't let `/gan` per-run state bleed into `.claude/gan/` or `.gan-cache/`.
- Don't merge to `main` mid-pivot (before the post-E1 revision break closes).
- Don't add ecosystem-specific tokens (`npm`, `gradle`, `pip-audit`, etc.) outside their owning stack file or an allowlisted path. `lint-no-stack-leak` is the permanent backstop.
- Don't expand the runtime-knob surface count without editing the roadmap's Runtime knobs table in the same PR.
- Don't author new top-level project directories for gan data without amending F1 first.

## Known gaps

- No `package.json`, no Node code, no schemas on disk yet. R1 (Phase 2) introduces them.
- No CI workflows on disk yet. R4 introduces them.
- No tests, no fixtures, no synthetic-second stack on disk yet. R1's first sprint slice introduces fixtures.
- No `stacks/` directory yet. E2 introduces `web-node` + `generic`.
- No linter, formatter, or type-checker chosen. Decision deferred to R1.
- README still describes the legacy `.gan/`-based architecture. E1 rewrites it; do not touch it before then.
