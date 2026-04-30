# Project context

_Last verified: 2026-04-30 by spec-validator_

This repo is the RFC + implementation work for ClaudeAgents' "stack plugin" redesign. It is currently spec-only — implementation has not started. Phase 0 (foundations: F1–F4) is the first work to land.

## Tech stack

- **Spec authoring:** Markdown only. Specs live under `specifications/` with phase-coded filenames (F/C/R/E/M/U/O + S deferred).
- **Future runtime tooling:** Node 18+ (R1 MCP server, R3 CLI wrapper, R4 maintainer scripts). Distributed via npm. No package manifest yet.
- **Future installer:** Bash (`install.sh`). The current 138-line `.gan/`-based installer is legacy and will be rewritten in place by R2.
- **Future schemas:** JSON Schema documents at `schemas/<type>-vN.json` (per F3). None on disk yet.
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
- Honor the **single-writer rule** for `.claude/PROJECT_CONTEXT.md`: only spec-validator writes; other agents read.
- Use **Node 18+ for maintainer tooling only**. End-user experience on non-Node ecosystems must never require Node at runtime.

**Don't:**
- Don't introduce backward-compatibility shims or transitional dual-path windows. Pre-1.0; schema changes bump `schemaVersion` and break.
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
