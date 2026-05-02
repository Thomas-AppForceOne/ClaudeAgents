# Post-R contract audit

_Run: 2026-05-01. Auditor: spec-validator. HEAD: `fd8ec15` (R5 S4)._

This is the audit gate defined in `roadmap.md` ("Revision break — post-R contract audit"). The R-series (R1-R5) is the first time the F- and C-phase contracts have been exercised against real code; this report surfaces gaps the specs missed before Phase 3 (E1) starts. Specs are revised IN PLACE per the user's later approval; this audit only proposes revisions.

## 1. Summary

The R-series is in good shape overall and Phase 3 is **not blocked** in any structural way — every contract is implemented, the test suite is green at 601 tests, and no foundational rule is being silently violated. Findings cluster into three buckets:

1. **Naming / wording drift** between specs and code that needs reconciliation: the user-overlay file is `user.md` in code but `config.md` in C3/C4/U2/F4; the DRAFT banner has three slightly different wordings across R3/R4/F3/PROJECT_CONTEXT/code; the C1 stack-file format is described as "frontmatter + body YAML block" but R1 implements a single frontmatter block (and every fixture and the scaffold use the single-block form).
2. **F2 surface drift**: R1 exposes five tools that F2's table does not list (`getMergedSplicePoints`, `getStackResolution`, `appendToOverlayField`, `removeFromOverlayField`, `trustList`) and three error codes F2 does not enumerate (`NotImplemented`, `MalformedInput`, `CacheEnvConflict`). The `trustApprove` signature changed (server computes hash; F2 says caller passes `contentHash`).
3. **C3 user-tier-forbidden enforcement is missing in R1**: C3's "user overlay declaring `additionalContext` / `stack.override` / `stack.cacheEnvOverride` is a hard error at load time" is not implemented anywhere in the loaders or writes. There is also a duplicate path-escape implementation (`path.no_escape` and `path.escape` both check the same overlay fields and both run, so an offending path produces two issues).

C-series merge rules and resolver behaviour match implementation. F4/R5 trust mechanism is shipped to the v1 scope and the deferred bits are clearly catalogued. C4 has a single internal contradiction (line 107-108 example contradicts the line 28 "stack.override is project-only" rule); spec-side cleanup, not a code bug.

The trust-prompt UX ("exercise against three real PRs") cannot be exercised in a desk audit; that is flagged as an open question. None of the findings warrant blocking E1; recommend the user resolve the spec-revision list in section 7 before E1 commits land, since E1 will read these specs as authoritative.

**Update — user review complete (2026-05-02).** All nine open questions have been resolved during interactive review with the user; resolutions are captured inline in §6. One additional open question (OQ#9 — platform priority) was raised during review and resolved in the same pass. Section 7's revision list now stands at 30 items, with items 4, 9, 10, and 16 tightened from "either/or" to definitive directions per the user's decisions on OQ#7, #4, #6, and #2 respectively. The audit gate is closed pending implementation of the approved revisions.

## 2. Methodology

I read every in-scope spec (F1-F4, C1-C5, R1-R5) and sampled the implementation:

- **Source code:** `src/config-server/{tools,storage,resolution,invariants,trust,determinism,validation}/`, `src/cli/{commands,lib}/`, `install.sh`, `scripts/{lint-stacks,lint-no-stack-leak,publish-schemas,evaluator-pipeline-check,pair-names,lint-error-text}/`.
- **Schemas:** `schemas/stack-v1.json`, `schemas/overlay-v1.json`, `schemas/api-tools-v1.json`.
- **Tests:** sampled `tests/cli/*`, `tests/config-server/{invariants,tools,integration}/*`, `tests/installer/*`. Did not read every test.
- **Commits:** `git log --oneline feature/stack-plugin-rfc` to map sprint commits to spec coverage.
- **Test run:** `npm test 2>&1 | tail -5` confirms 601 tests pass.
- **Greps:** `grep -rn "TODO" src/ scripts/`, `grep -rn "deferred" src/`, plus targeted greps for spec-vs-code naming (e.g. `user.md` vs `config.md`, banner text variants).

I did **not**:

- Read every line of every source file (sampled 2-5 per spec).
- Run F4's trust prompt against three real PRs (impossible in a desk audit).
- Test the `gan trust export`/`import` round-trip (deferred per R5 spec).
- Read every test for every invariant.
- Walk every cross-reference in PROJECT_CONTEXT.md against every spec.

Findings should be confirmed by the user against the cited paths before any spec edit lands.

## 3. Findings by spec

### F1 — filesystem layout

**Status:** verified-clean.

1. Three zones (`/.claude/gan/`, `/.gan-state/`, `/.gan-cache/`) appear consistently across `install.sh` (lines 366-389, 688), `src/config-server/storage/overlay-loader.ts`, and PROJECT_CONTEXT.md. Single-owner-lifecycle invariant holds: writers never cross zone boundaries in any sampled code path.
2. Pre-existing `.gan/` hard-error policy (F1 line 87, 100) is not yet exercised — there is no enforcement code in R1's startup or in `install.sh` that errors on a pre-existing top-level `.gan/`. F1's AC #1 says this fires from `/gan`, which is E1's territory; R1 does not need to enforce it. **No action**.
3. F1 lists `.claude/gan/modules/<module>.yaml` (line 50) as zone 1 contents. R1 does not yet implement module-config reading from this path; M1 will. **No action** (deferred per spec design).

**Recommended actions:** none.

### F2 — Configuration API contract

**Status:** minor-revision-suggested.

1. **F2's tool table is missing five tools the implementation ships.** R1 registers `getMergedSplicePoints`, `getStackResolution`, `appendToOverlayField`, `removeFromOverlayField`, `trustList` (see `src/config-server/index.ts:64-96` and `R5_TOOL_NAMES` line 106). F2's tables (lines 51-78) list 23 tools; the implementation has 28. The five additions are reasonable (symmetry with stack-field operations; structured access to the resolver's intermediate outputs); F2 should be updated to reflect them.
2. **F2's structured-error enum is missing three codes the implementation ships.** `src/config-server/errors.ts:13-27` declares `NotImplemented`, `MalformedInput`, `CacheEnvConflict` in addition to F2's 11 enumerated codes. `NotImplemented` is a sprint-stub artefact; `MalformedInput` is real (used pervasively for bad CLI/tool inputs); `CacheEnvConflict` is the C1 conflict-resolution error specialised. F2's enum and the CLI exit-code table (R3 spec) should both list these explicitly.
3. **F2's `trustApprove(contentHash, note?)` signature does not match the implementation.** F2 line 77 says callers pass `contentHash`; `src/cli/commands/trust-approve.ts:69` and `src/config-server/tools/writes.ts` show the implementation takes `{projectRoot, note}` and the server recomputes the hash. The implementation is more correct (single source of truth for the hash), but F2's signature should be updated.
4. **F2's "Capability binding is out of scope for v1" check (line 41).** R3 reads `--project-root` from the command line, defaults to `process.cwd()`, and trust-mutating commands require it explicitly (`src/cli/commands/trust-approve.ts:45-54`). The orchestrator (E1) is the other caller; not yet implemented. R1 does not surface user-influenced strings into `projectRoot` as far as I can see. The deferral remains valid; no current code path violates it. **Note for E1:** this needs a re-check when E1's caller graph is concrete. Flag as an open question (section 6, OQ#3).
5. **F2 lists `getOverlayField(path)` (line 58) but it is one of the two reads still flagged `NotImplemented`** (per `src/config-server/index.ts:9-11`). F2 should not need to change here; this is an R1-side gap to close before E1 ships, since E1 may use the per-field read pattern. Flagged as a Phase-3 prerequisite, not a spec issue.

**Recommended actions:** add the five tools and three error codes to F2's tables; update `trustApprove` signature to `(projectRoot, note?)`. See section 7, items 1-3.

### F3 — Schema authority and versioning

**Status:** minor-revision-suggested.

1. **F3 catalogue lists `path.no_escape` (line 84); R1 ships TWO invariants both checking the same fields.** `src/config-server/invariants/index.ts:60-61` registers BOTH `path.escape` (raises `PathEscape`) and `path.no_escape` (raises `InvariantViolation`). Both check `planner.additionalContext` and `proposer.additionalContext` for descendant-of-root. An offending path triggers both, producing two issues for the same defect. This violates the single-implementation rule (PROJECT_CONTEXT.md line 144). The sprint comment in `path-escape.ts:1-9` acknowledges the intention to introduce `PathEscape` as the F2-coded version while keeping `path.no_escape` for the "no new error codes" rule of an earlier sprint, but the result is a dual-implementation. **Recommended:** delete `path.no_escape` (and its file/test) and rely on `path.escape` exclusively. Or delete `path.escape` and update `path.no_escape` to emit `PathEscape`. Either way, single implementation only.
2. **F3 catalog covers 9 invariants; R1 ships 9 invariants (excluding `trust.approved` per OQ1, which is the documented R5 deferral).** Match. The duplicated path invariant counts as 9 distinct file slots in the catalog if both are kept; today the registry has 9 entries because `path.escape` was added without removing `path.no_escape`. After the consolidation (finding #1) the count returns to 8.
3. **`schemas/api-tools-v1.json` has 28 tools.** F3 (and F2) need to acknowledge the catalogue. F3's "Schema authoring" section (lines 11-25) names `stack-v1.json`, `overlay-v1.json`, `module-manifest-v1.json` but not `api-tools-v1.json`. Recommend a one-sentence addition naming the file.
4. **Determinism pin behaviour matches spec.** `src/config-server/determinism/index.ts` implements picomatch v4, `realpathSync.native` + trailing-slash strip + lowercase on Darwin/Win32, sorted-key JSON, locale-sensitive sort. F3 line 52 says "case-insensitive filesystem normalisation by canonical-path comparison"; the implementation lowercases (which is one valid interpretation but not literally "canonical-path comparison"). Practically equivalent; specs may want to mention the lowercase choice explicitly so future contributors don't re-litigate it.

**Recommended actions:** consolidate to one path-escape invariant; mention `api-tools-v1.json`; clarify the lowercase canonicalisation interpretation. See section 7, items 4-5.

### F4 — Threat model and trust

**Status:** minor-revision-suggested.

1. **F4 line 138 ("`strict` mode: `validateAll()` succeeds for read-only purposes…").** The implementation in `src/config-server/trust/integration.ts:72-167` returns an `UntrustedOverlay` issue from `validateAll()` whenever the user has not approved AND `GAN_TRUST` is `unset` or `strict`. So under strict + unapproved, `validateAll()` returns an error, not "succeeds". The CLI surfaces this as exit code 2, which is consistent with R5's AC: "`GAN_TRUST=strict` causes CI runs to fail closed with `UntrustedOverlay` for any unapproved hash." Either F4's wording is sloppy or the implementation diverges. I read the F4 line as "strict mode: validateAll succeeds for read-only purposes (gan validate prints the report) but errors at the trust check; /gan halts." That's effectively what happens — the read-only `gan validate` prints structured errors and exits 2, and `/gan` would halt because it would refuse to run on the validation failure. F4 should clarify this wording to remove the apparent contradiction. **No code change.**
2. **F4's interactive prompt UX (lines 86-122) cannot be exercised in a desk audit.** The roadmap calls for testing against three real PRs (`config-only`, `config + script`, `new project-tier stack file`). I cannot do this from a static review. The prompt text itself lives in `skills/gan/trust-prompt.md` per R5 line 107; that file does not yet exist on disk (R5 S5 was an E1 sprint slice, deferred per the R5 bite-size note). The interactive prompt is not yet shipped. Open question (section 6, OQ#1).
3. **F4 line 127 (`[v]` view UX) — "shows a high-level summary of what changed plus a git-pointer follow-up".** R5 S4 ships `getTrustState()` which returns the high-level summary (counts of `additionalChecks` etc., per `src/config-server/tools/reads.ts:300-340`). The full `[v]` flow that ties this into the prompt is not yet implemented because the prompt isn't yet shipped. F4's structured per-file diff is explicitly deferred (R5 line 183). Acceptable; flagged as deferred (section 5).
4. **F4's `--no-project-commands` log content rule (line 187) — names every suppressed surface "including custom-stack drop-throughs".** R5 implements the runtime knob (`runtimeMode.noProjectCommands` in resolved-config), but the command-execution paths and log emitters belong to E1's orchestrator. R1 ships the data; the consumer is E1. Cannot exercise from R1 alone.
5. **F4 line 33 lists files in the trust hash: `.claude/gan/project.md`, `.claude/gan/stacks/`, `.claude/gan/modules/`.** `src/config-server/trust/hash.ts` should be checked but I did not read it directly; the cache-io.ts comments imply the spec is honoured. (Sample-level confidence; recommend full read in a follow-up if unsure.)
6. **F4 line 76 — `UntrustedOverlay` fires only when "the committed config contains at least one field that could declare a shell command".** `src/config-server/trust/integration.ts:197-210` (`projectDeclaresCommands`) checks `evaluator.additionalChecks` only. The `TODO(post-E1)` at line 192 acknowledges that per-stack `auditCmd`/`buildCmd`/`testCmd`/`lintCmd` overrides are not yet checked. F4's wording covers all of those; the implementation is narrower in v1. Catalogued as a deferred bit (section 5).

**Recommended actions:** clarify F4 line 138 (strict mode + unapproved fires error); leave OQ on real-PR exercise. See section 7, item 6.

### C1 — Stack plugin schema

**Status:** blocking-revision-needed (parse contract diverges from implementation).

1. **C1 lines 8-12 define a two-block file format: "one YAML frontmatter block AND one canonical YAML body block".** Every implementation artefact uses **a single YAML frontmatter block** containing all fields:
   - `tests/fixtures/stacks/js-ts-minimal/stacks/web-node.md` has one `---`-delimited block with `name`, `schemaVersion`, `detection`, `scope`, `buildCmd`, `testCmd`, `lintCmd` all together.
   - `src/cli/lib/scaffold.ts:65-92` produces a single `---`-delimited block containing `schemaVersion`, `name`, `detection`, `scope`, `buildCmd`, `testCmd`, `lintCmd`, `auditCmd`, `secretsGlob`, `securitySurfaces`.
   - `src/config-server/storage/yaml-block-parser.ts` parses one frontmatter block delimited by `---` lines.
   - `schemas/stack-v1.json` has top-level properties `auditCmd`, `buildCmd`, `cacheEnv`, `detection`, `lintCmd`, `scope`, `secretsGlob`, `securitySurfaces`, `testCmd` — i.e. the body schema's properties are exactly the same fields C1 spec puts in BOTH frontmatter and body.

   This is a substantive divergence: C1's example (lines 11-78) shows a frontmatter block with `name` / `description` / `schemaVersion` followed by a separately-delimited ```` ```yaml ```` body block with everything else. The implementation collapsed them. The implementation's choice is fine (simpler, fewer parsing edge cases), but C1's prose and example need to be rewritten to match.

2. **C1 line 91 — `name` is "the stack's identifier… filename `stacks/<name>.md` must match the frontmatter `name`".** Implementation puts `name` in the (single) YAML block. Once C1 is rewritten, the rule is "the `name` field in the YAML block must match the filename", which preserves the original intent.
3. **C1 line 223 lint AC: "rejects unstructured (string) `auditCmd`".** `schemas/stack-v1.json:68-122` defines `auditCmd` as `oneOf` two object shapes (silent vs. blocking/warning) — strings are rejected. Match. ✓
4. **C1 line 105 — `{path, contains}` and `{anyOf, allOf}` detection composites.** `schemas/stack-v1.json:5-65` (definitions.detectionEntry) covers all four forms via `oneOf`. Match. ✓
5. **C1 line 130 default for `scope`: "if omitted, scope is the union of detection path globs and `**/*.{ext}` for every extension in `secretsGlob`".** I did not verify this default in `src/config-server/resolution/detection.ts`; sample-level confidence.
6. **R3 spec scaffold example (R3 line 86-88) shows `lintCmd` as an OBJECT with `command`/`absenceSignal`.** `schemas/stack-v1.json:154-156` declares `lintCmd: type: string`; `src/cli/lib/scaffold.ts:83` writes it as a string. C1 spec line 173 says `lintCmd` is a string. The R3 spec example is wrong; the implementation is right. R3 spec needs fixing, not C1.

**Recommended actions:** rewrite C1's "Parse contract" section to describe a single YAML frontmatter block; update the example accordingly. Fix R3 scaffold example to show `lintCmd` as a string. See section 7, items 7-8.

### C2 — Stack detection and dispatch

**Status:** verified-clean.

1. Algorithm in `src/config-server/resolution/detection.ts` (sampled) and `src/config-server/resolution/resolved-config.ts:1-100` matches C2's algorithm: enumerate, evaluate detection per stack, union active set, scope-filter applied at consumption time.
2. C2 line 19 ("if no stack matches, activate `stacks/generic.md`") — the `stacks/generic.md` file does not exist on disk yet (E2 ships it). R1's tests cover the active-set-empty case via `tests/fixtures/stacks/synthetic-second/`; cannot verify the generic-fallback AC end-to-end until E2.
3. C2 line 28 (`Invalid detection glob` error) — picomatch silently treats invalid patterns as literal strings rather than throwing; not sure if R1's detection raises a structured error for unparseable globs. Sample-level note; would require reading detection.ts in full.
4. C2 line 31 (empty-scope-after-activation = warning) — sampled; matches spec.

**Recommended actions:** none. Confirm C2#3 (invalid glob error) at first opportunity in E1's exercise.

### C3 — Overlay schema

**Status:** blocking-revision-needed (one major implementation gap).

1. **C3's "User-overlay forbidden fields" rule (lines 71-75) is not implemented.** A user overlay declaring `additionalContext`, `stack.override`, or `stack.cacheEnvOverride` should be a hard error at load time; `src/config-server/storage/overlay-loader.ts` and `src/config-server/validation/schema-check.ts` neither know about tier nor reject these fields tier-wise. `tests/config-server/tools/writes.test.ts:472-493` actively *exercises* writing `planner.additionalContext` to the user tier and expects success. This is a contract bug. Either the rule should be enforced (recommended; matches the threat model — user-tier `stack.override` would silently switch the active set across every project) or C3 must be revised to accept user-tier values for these fields.
2. **C3 line 12 calls the user overlay `~/.claude/gan/config.md`.** Code at `src/config-server/storage/overlay-loader.ts:113` uses `~/.claude/gan/user.md`. F4 line 148, U2 lines 17, 87 also use `config.md`. Three options: (a) rename the on-disk file in code to `config.md` to match specs, (b) revise C3/C4/F4/U2 to say `user.md`, (c) accept as both (file lookup tries both paths). PROJECT_CONTEXT.md does not currently document the chosen filename. Recommend (b): update specs to `user.md` since code is shipped and reflects the implementer's deliberate choice.
3. **C3's splice-point catalog matches `cascade.ts:60-...` SPLICE_POINTS table.** All nine catalog rows (`stack.override`, `stack.cacheEnvOverride`, `proposer.additionalCriteria`, `proposer.suppressSurfaces`, `proposer.additionalContext`, `planner.additionalContext`, `generator.additionalRules`, `evaluator.additionalChecks`, `runner.thresholdOverride`) appear with matching merge-rule encoding. ✓
4. **C3's `discardInherited` two-form rule** (block + field-level, with field-level winning) — implemented in `cascade.ts` per the SpliceRule mechanism. Tests under `tests/config-server/resolution/` cover this. Match. ✓
5. **C3 line 89 (inactive-stack `cacheEnvOverride` warning).** I did not verify this is implemented; sample-level. Recommend confirming during the C3-vs-code re-audit pass once finding #1 lands.
6. **C3 line 91 (`proposer.suppressSurfaces` warning when stack inactive or surface-id unknown).** Same as #5; not verified.

**Recommended actions:** implement user-tier-forbidden enforcement (or revise C3); rename file in spec or code. See section 7, items 9-11.

### C4 — Three-tier overlay cascade

**Status:** minor-revision-suggested (one internal contradiction in the spec).

1. **C4 line 107 contradicts C4 line 28 and C3 line 61.** Line 107 reads: "With a user overlay declaring `stack.override: [foo]` and a project overlay declaring `stack.override: [bar]`, the active set contains both `foo` and `bar`." But line 28 says `stack.override` is **project-only** (user value rejected at load), and C3 line 61 explicitly says `stack.override` is "Project-only; user value rejected at load". A user-tier value cannot exist at all under the documented rule; the AC can never fire. This AC was likely a residue from a draft where `stack.override` was union-merged.
2. **C4 line 33-44 (duplicate-key positioning rule, mixed-overrides-and-new-entries).** Implementation matches: list-union-by-key and list-union-by-string in `cascade.ts`. The worked example at line 87-93 is testable and likely covered by tests. ✓
3. **C4's `discard-then-empty fallback` rule (line 54-59).** Implementation honours `bareDefault()` in `cascade.ts:50-103`. ✓
4. **C4's "merge order = execution order" guarantee for `evaluator.additionalChecks` (line 42).** Implementation preserves order via list-union-by-key-command. ✓ (sampled tests).

**Recommended actions:** delete or rewrite C4 line 107-108. See section 7, item 12.

### C5 — Stack file resolution

**Status:** verified-clean.

1. **C5's three-tier resolution.** `src/config-server/resolution/stack-resolution.ts:49-78` implements:
   1. project tier → `<projectRoot>/.claude/gan/stacks/<name>.md`
   2. user tier → `<userHome>/.claude/gan/stacks/<name>.md`
   3. built-in tier → `<projectRoot>/stacks/<name>.md`

   Highest-priority wins; wholesale replacement (no merging). Matches C5 lines 9-29. ✓
2. **C5 spec's `<repo>/stacks/<name>.md` reads as "the canonical built-in directory shipped with ClaudeAgents".** The implementation interprets `<repo>` as `<projectRoot>` — the project's own `stacks/` dir. This works for the in-repo dev use case (developers running `gan` against the framework repo itself) but does NOT find a built-in stack file when the user runs `gan` against a foreign project (i.e. the npm-installed binary cannot find `stacks/web-node.md` from `<projectRoot>/stacks/`). E2 ships actual built-in stacks; this is the right time to revisit. **Open question** (section 6, OQ#5).
3. **C5's `pairs-with` shadowed-default error wording (line 21-25).** `src/config-server/invariants/pairs-with-consistency.ts:48-65` (sampled) reproduces the exact remediation hint format. ✓
4. **C5 stack-tier names: spec uses "tier 1/2/3" or "project/user/repo"; code uses "project/user/builtin".** Minor terminology inconsistency. Spec text already says "built-in" sometimes (e.g. line 13 "built-in defaults"). Recommend specs settle on `project | user | builtin` to match code, since the same labels appear in JSON output via `getStack()`.
5. **C5 line 27 — "API records which tier each active stack came from… exposes it via `getResolvedConfig()`".** `src/config-server/resolution/resolved-config.ts:77-80` (`ResolvedStackEntry.tier`) records this. ✓

**Recommended actions:** unify tier-name terminology in C5 and downstream specs (`project|user|builtin`). See section 7, item 13.

### R1 — Configuration MCP server

**Status:** verified-clean.

1. **R1's repository layout** (R1 lines 13-39) closely matches `src/config-server/`. Implementation has additional dirs (`trust/`, `validation/`, `logging/`) that R1 spec does not list — R5 added `trust/`, R1 itself added `validation/` and `logging/` for the validation and per-run-log routing already covered in PROJECT_CONTEXT.md. Recommend R1 spec be updated to list these subdirectories explicitly so the layout invariant is closed.
2. **R1's "single-implementation rule" for cross-file invariants** (line 144 of PROJECT_CONTEXT.md, R1 line 32-39) — violated by the duplicate path-escape invariants (see F3 finding #1). Concrete fix: collapse `path.no_escape` and `path.escape` into one.
3. **R1's resolver cache scope (lines 73-80).** Implementation in `src/config-server/resolution/cache.ts` (sampled) holds entries keyed by canonical projectRoot. Invalidation triggers on writes. Sample-level confidence. ✓
4. **R1 sprint slicing (lines 137-145).** Commits show 7 sprints: skeleton, reads + YAML, validation, invariants, resolver, writes, integration tests. Matches the bite-size note exactly. ✓
5. **R1 line 56 — Phase order in `validateAll()`.** Implementation runs four phases: discovery, schema, invariants, trust (`src/config-server/tools/validate.ts:147-157`). R5 added the trust phase per spec. ✓
6. **R1 line 92 — atomic temp-file + rename for writes.** `src/config-server/storage/atomic-write.ts` (sampled). ✓
7. **R1 line 110-112 — per-run log routing**. `src/config-server/logging/` exists; PROJECT_CONTEXT line 158 confirms the rule (route to `.gan-state/runs/<id>/logs/` when `GAN_RUN_ID` is set). Sampled.

**Recommended actions:** update R1 directory layout list to include `trust/`, `validation/`, `logging/`, `scaffold-banner.ts`, `schemas-bundled.ts`. See section 7, item 14.

### R2 — Installer

**Status:** verified-clean.

1. **R2's MCP entry name (`claudeagents-config`).** `install.sh:326` writes the entry under `mcpServers.claudeagents-config`. ✓
2. **R2 line 21 says `npm install -g @claudeagents/config-server`.** `install.sh:244` uses `npm install -g .` (local). PROJECT_CONTEXT lines 23-24 document this as the deliberate "local-install-only until the package is published" rule. R2 spec text needs a one-line note.
3. **R2's idempotency-via-version-probe** rule — `install.sh:220-227` checks `claudeagents-config-server --version` before installing. ✓
4. **R2 line 22 says `MCP_SERVER_VERSION` is read from `package.json` at runtime.** `install.sh:152-154` does this via `node -p`. ✓
5. **R2 line 19 prerequisite checks.** `install.sh:101-150` checks Node version (20.10+ <= 22), git, claude-code (with `--no-claude-code` skip). ✓
6. **R2 feature-branch warning** (lines 14-15, mid-pivot) — `install.sh` has `feature_branch_warning` per `MIDPIVOT_WARNING_FIRED`. ✓
7. **R2 "rollback on partial failure"** — implemented per `STATE_LOG` audit trail. ✓
8. **R2 acceptance criteria all green** per `tests/installer/` (sampled).

**Recommended actions:** add "local-install-only" note to R2 line 21. See section 7, item 15.

### R3 — CLI wrapper

**Status:** minor-revision-suggested.

1. **R3 line 65 example scaffold has `# DRAFT — replace TODOs and remove this banner before committing.`** (longer text). PROJECT_CONTEXT line 169 also says "and remove this banner". But:
   - F3 line 89 says the banner is `# DRAFT — replace TODOs before committing.` (shorter).
   - R4 line 48 says `# DRAFT — replace TODOs before committing.`
   - R3 line 32 says `# DRAFT — replace TODOs before committing` (shorter, missing period).
   - Code at `src/config-server/scaffold-banner.ts:19` exports `'# DRAFT — replace TODOs before committing.'` (shorter).
   - Code at `src/cli/lib/scaffold.ts:37` then adds a SECOND_LINE: `"# `gan validate` and CI's lint-stacks will fail while this banner is present."`

   So the actual rendered scaffold is two lines: the BANNER (short) plus the SECOND_LINE. PROJECT_CONTEXT and R3 line 65 conflate them into a single longer line. Spec edits needed: pick one canonical short banner string, document the second-line warning separately, fix R3 line 65 example to render the two lines correctly.
2. **R3 line 31 lists tier flag values: `--tier=project|repo`.** Code at `src/cli/commands/stacks-new.ts:39-80` rejects `--tier=user` explicitly. Match. ✓
3. **R3 line 107 says `gan stacks new` "refuses to overwrite". Code does this** (`stacks-new.ts:137-144`). ✓
4. **R3 lines 117-127 exit-code table.** Code at `src/cli/lib/exit-codes.ts:18-44` matches. The implementation table also includes mappings for `MalformedInput → 64`, `CacheEnvConflict → 4`, `PathEscape → 4`, `UntrustedOverlay → 2`, `TrustCacheCorrupt → 1` — these are choices not in the spec table. R3's exit-code table should be expanded to enumerate every F2-error → exit-code mapping, not leave them implicit.
5. **R3 line 65 scaffold example shows `lintCmd` as an OBJECT** with `command`/`absenceSignal` fields. Schema and code make `lintCmd` a string. Fix R3 example.
6. **R3 line 86 `testCmd: "false  # TODO..."`** — also showing `testCmd` as a string. Match with schema. ✓
7. **R3 line 39 — `gan --help`, `gan -h`, `gan help`, bare `gan` all print help and exit 0.** `src/cli/index.ts` (sampled) handles all four. ✓
8. **R3 line 42 — trust subcommands** ship with R5 in `src/cli/commands/trust-*.ts`. ✓
9. **R3 line 156-161 acceptance criteria for help / scaffold-banner** are exercised by `tests/cli/` test files. ✓

**Recommended actions:** fix banner text canonicalisation across R3, R4, F3, PROJECT_CONTEXT; fix R3 scaffold example for `lintCmd`; expand R3 exit-code table. See section 7, items 16-18.

### R4 — Maintainer tooling

**Status:** verified-clean.

1. **All five scripts ship** — `lint-stacks/`, `lint-no-stack-leak/`, `lint-error-text/`, `pair-names/`, `publish-schemas/`, `evaluator-pipeline-check/` (six in total counting the eval harness). ✓
2. **Seven CI workflows ship** at `.github/workflows/`: shared-setup, test-error-text, test-evaluator-pipeline, test-modules, test-no-stack-leak, test-schemas, test-stack-lint. Matches roadmap inventory. ✓
3. **`scripts/lint-no-stack-leak/forbidden.json`** — exact content match with R4 spec line 73-85. ✓
4. **Allowlist transitional entries** (R4 line 105-115) — inspected in code; sampled match with the spec's transitional list. ✓
5. **`scripts/publish-schemas/index.ts:158`** has `TODO(future)` for "fenced JSON Schema in domain specs". This means the script doesn't yet extract schemas from spec source — it just diff-checks the on-disk schemas. R4 line 53 ("publish-schemas re-extracts and writes them") is technically more than what's shipped; the script verifies drift but does not extract from spec content. Catalogued in section 5.
6. **`scripts/evaluator-pipeline-check/index.ts`** has three `TODO(E3)` markers (lines 52, 138, 147). R4 line 60 says E3's reference implementation is here. The script ships a skeleton; full E3 work lands later. Catalogued in section 5.
7. **R4 line 124-132 `lint-error-text`** ships at `scripts/lint-error-text/index.ts`. Allowlist exists. ✓

**Recommended actions:** none — but mention that `publish-schemas` is drift-check-only in v1 (R4 spec wording slight overpromise). See section 7, item 19.

### R5 — Trust cache implementation

**Status:** minor-revision-suggested.

1. **R5 lines 30-35 list four MCP tools** (`trustApprove`, `trustRevoke`, `trustList`, `getTrustState`). All ship in `src/config-server/tools/{reads,writes}.ts`. F2 only lists three of them; `trustList` was added by R5 and isn't in F2. ✓ for R5; F2 should be updated (already in F2 finding #1).
2. **R5 line 32 — `trustApprove(projectRoot, contentHash, note?)`**. Implementation takes `(projectRoot, note?)`. Already noted in F2 finding #3. R5 spec also needs the same wording fix.
3. **R5 lines 37-47 hash algorithm** — implementation in `src/config-server/trust/hash.ts` (sampled via cache-io.ts comments). Each per-file hash + aggregate over sorted-path order. ✓
4. **R5 line 70 — file mode `0600`.** `src/config-server/trust/cache-io.ts:50` imports `chmodSync` and the comments confirm 0600 is enforced. ✓
5. **R5 line 79-95 — trust check phase in `validateAll()`.** Match in `src/config-server/tools/validate.ts:147-157`. ✓
6. **R5 line 99-105 interactive prompt.** Not yet shipped; R5 line 221 places it as an E1 sprint slice (Slice 5). The skill prompt file `skills/gan/trust-prompt.md` does not yet exist. Catalogued in section 5.
7. **R5 line 168-176 `gan trust *` CLI surfaces.** `src/cli/commands/trust-{info,approve,revoke,list}.ts` ship; trust-mutating commands enforce explicit `--project-root`. ✓
8. **R5 line 191 ACs:** `~/.claude/gan/trust-cache.json` is created on first approve, hash-deterministic, etc. — exercised in `tests/cli/trust-*.test.ts` and `tests/config-server/trust/*`. ✓
9. **R5 line 197 — `--no-project-commands` log content** — runtime knob shipped (`runtimeMode.noProjectCommands` in resolved-config) but the log emitter (E1's evaluator path) is not yet implemented because E1 is not yet shipped.
10. **R5 line 197 `projectDeclaresCommands` predicate is narrower than the spec** (only checks `evaluator.additionalChecks`, not per-stack command overrides). `TODO(post-E1)` at `src/config-server/trust/integration.ts:192`. Catalogued in section 5.

**Recommended actions:** fix `trustApprove` signature in R5 to match implementation. See section 7, item 20.

## 4. Cross-cutting observations

1. **Single-implementation rule.** Mostly honoured. **One concrete violation:** `path.no_escape` + `path.escape` invariants (and a third copy of the descendant-check helper in `additional-context-path-resolves.ts`). Recommend collapsing to one invariant + one shared helper for "is this canonical path a descendant of canonical root."
2. **Error factory rule.** `src/config-server/errors.ts` is the single producer; all errors flow through `createError`. Sampled three subsystems (trust, invariants, writes); no inline `throw new Error()` for known codes. ✓
3. **Determinism pins.** `src/config-server/determinism/index.ts` is the single source. Imports from the rest of the codebase route through it. ✓
4. **Single-source-of-truth for shared constants.** Mostly honoured (the DRAFT banner is one constant in `src/config-server/scaffold-banner.ts` re-exported by `src/cli/lib/scaffold.ts`). The cross-spec banner-text mismatch (R3 spec line 65 vs code) is a documentation issue, not a code duplication. **One issue:** the second scaffold line ("# `gan validate` and CI's lint-stacks will fail while this banner is present.") lives only in `scaffold.ts:37`. Tests and PROJECT_CONTEXT do not codify it; if a future maintainer changes the banner text, only the first-line constant change is centralised. Recommend either (a) move SECOND_LINE to `scaffold-banner.ts` next to `DRAFT_BANNER` for symmetry, or (b) accept that the second line is scaffold-only metadata not subject to invariant checks.
5. **Test patterns.** Vitest + child_process.spawn for installer / CLI; pure-function tests for resolvers / invariants. Consistent across R1-R5. ✓
6. **Naming consistency.** Tier names are `project|user|builtin` in code but `project|user|repo` and `tier 1|2|3` and `built-in` in specs. The implementation's choice (`builtin`) is fine; specs should converge. Same issue: user-overlay file is `user.md` in code, `config.md` in C3/C4/F4/U2.
7. **F2 surface vs `api-tools-v1.json`.** The schema document is the source of truth for tool input shapes; F2's prose enumerates 23 of 28. The five "extra" tools were added by R1 (`getMergedSplicePoints`, `getStackResolution`) and R5 (`trustList`) plus two for write-symmetry (`appendToOverlayField`, `removeFromOverlayField`). All are reasonable; F2 needs updating, not the schema.
8. **CLI exit-code map.** R3's exit-code table is partial; the implementation's table at `src/cli/lib/exit-codes.ts:26-45` enumerates every F2 code. Recommend the spec list match the implementation 1:1 so future error codes always have a documented mapping.

## 5. Deferred items inventory

The following are catalogued as deferred-by-design or deferred-to-follow-up. The user should confirm none should be promoted before Phase 3:

### From R5 (per the spec's "Deferred to a follow-up spec" section, lines 179-189)

1. **Per-file hashes in the cache** — precondition for a structured per-file diff in `[v]` view. v1 stores aggregate-only via `src/config-server/trust/cache-io.ts`. (Cache shape allows extending; not blocking.)
2. **`getTrustDiff()` MCP tool** — currently a loud-stub returning `{ diff: [], reason: 'trust-not-yet-implemented' }` per `src/config-server/tools/reads.ts:274-283`. The MCP tool is registered; only the implementation is deferred.
3. **`gan trust export` / `gan trust import` manifest** — not implemented. CLI surfaces `info`/`approve`/`revoke`/`list` only.
4. **`GAN_TRUST=approved-hashes-only` mode** — not implemented. Two values currently: `strict`, `unsafe-trust-all`, plus unset.
5. **Cross-process advisory locks** on the trust cache — not implemented. Two-terminal-windows races accepted per spec.

### From R5 integration (`src/config-server/trust/integration.ts:192`)

6. **`projectDeclaresCommands` checks `evaluator.additionalChecks` only.** The full set per F4 (per-stack `auditCmd`/`buildCmd`/`testCmd`/`lintCmd` overrides reachable through the resolved view) is gated on the evaluator's command-fallback path landing — `TODO(post-E1)`.

### From R4 publish-schemas (`scripts/publish-schemas/index.ts:158`)

7. **Spec-extraction logic.** `TODO(future)`: when domain specs (C1, C3, F2) gain fenced JSON Schema blocks, this script would extract them and check the on-disk copy. Today the script only diff-checks the on-disk schemas. R4 spec line 53 wording is slightly aspirational; the v1 script does drift-check, not extraction.

### From R4 evaluator-pipeline-check (`scripts/evaluator-pipeline-check/index.ts`)

8. **Token normalisation seams** — three `TODO(E3)` markers (lines 52, 138, 147). The script ships a skeleton for E3; full deterministic-core normalisation (timestamps, tokens, byte-for-byte equality replacement with structured diff) lands when E3 is authored.

### From the R5 spec that aren't `TODO()` markers in code but are in the spec text

9. **Skill prompt file** at `skills/gan/trust-prompt.md` — not on disk yet (R5 line 107). E1 sprint slice (R5 line 221).
10. **`--no-project-commands` log emitter content** — runtime knob shipped in the resolved-config; the log emission belongs to E1's evaluator path.

### Untyped TODOs

I greppd `src/` for `TODO(E1)`, `TODO(E3)`, `TODO(post-E1)`, `TODO(future)`. The five named TODOs above are the full set. No surprises.

## 6. Open questions for the user

1. **OQ#1 — F4/R5 trust-prompt UX exercise against three real PRs. RESOLVED (2026-05-02) →** deferred to E1's first real-world PR review. The interactive prompt is an E1 sprint slice; the prompt text and routing are exercised by unit tests of `getTrustState()` already; a synthetic exercise now would not surface anything a real PR review wouldn't catch better. No spec revision needed.
2. **OQ#2 — Banner text canonicalisation. RESOLVED (2026-05-02) →** the canonical banner is the **longer form** `# DRAFT — replace TODOs and remove this banner before committing.` (matching PROJECT_CONTEXT.md line 169 and R3 line 65). All other locations update to this form. See spec revision §7 item 16 (rewritten below) and the implied code-and-test changes listed there.
3. **OQ#3 — F2 capability-binding deferral re-check. RESOLVED (2026-05-02) →** wait until E1 lands and the orchestrator's caller graph is concrete. The answer is more meaningful when there's a real caller pattern; no current code path violates the deferral. No spec revision needed.
4. **OQ#4 — User-tier file name (`user.md` vs `config.md`). RESOLVED (2026-05-02) →** code wins: the on-disk filename is `user.md`. Specs (C3, C4, F4, U2) update to match. See spec revision §7 item 9 (tightened below).
5. **OQ#5 — Built-in stack file location. RESOLVED (2026-05-02) →** the framework's npm package is the canonical source of built-in stacks; the resolver reads them directly from the npm install location.

   **Resolved design:**
   - Built-in stacks ship in the npm package at `<packageRoot>/stacks/<name>.md` (one per-machine install via `npm install -g`; `<packageRoot>` is computed at startup via the same `import.meta.url` walk-up R1 already uses to find its own `package.json`).
   - The C5 resolver tier ordering becomes: **(1)** project tier `<projectRoot>/.claude/gan/stacks/<name>.md`; **(2)** user tier `~/.claude/gan/stacks/<name>.md`; **(3)** built-in tier `<packageRoot>/stacks/<name>.md` (read-only, lives in node_modules).
   - The previous tier-3 path `<projectRoot>/stacks/<name>.md` is **dropped** entirely — it never had a coherent end-user mental model (would only resolve when projectRoot was the framework repo).
   - `install.sh` creates a symlink `~/.claude/gan/builtin-stacks/` → `<packageRoot>/stacks/` so the user-facing path is stable and discoverable regardless of npm install prefix (Homebrew node, nvm, asdf, system node, …). Symlink-creation is rolled back on uninstall via the existing STATE_LOG machinery.
   - Built-in stacks are **never** copied into a user project. Users who want to fork the default explicitly run `gan stacks customize <name> [--tier=project|user]`, which copies the built-in file into the chosen customization tier where they own it. `gan stacks reset <name>` is the inverse — delete the customization, fall back to built-in.
   - The CLI surface adds: `gan stacks available` (list `<packageRoot>/stacks/` contents), `gan stacks customize <name>` (vendor-for-edit), `gan stacks reset <name>` (drop fork, restore built-in), `gan stacks where [<name>]` (discovery — print the resolved path). The existing `gan stacks list` continues to report **active** stacks (per detection), which is now distinct from "available" (offered by framework) and "installed" (vendored at customization tier).
   - The maintainer-only `gan stacks new --tier=repo` flag is removed — there is no longer a meaningful repo-tier destination from the user's perspective. Maintainers authoring new built-in stacks edit the framework repo's `stacks/` source tree directly.
   - **GitHub-as-source was considered and rejected.** Live-fetching from GitHub on `gan stacks customize` would break offline use, lose determinism (same command, different output depending on when run), complicate trust-cache hashing, and make the framework dependent on a specific git host. The "always-current defaults" property GitHub-fetch offered is solved by faster npm releases — process discipline, not architecture.

   See spec revisions §7 items 21-27.
6. **OQ#6 — User-tier-forbidden enforcement. RESOLVED (2026-05-02) →** implement the rejection. C3's threat-model invariant stands; the implementation will start rejecting `additionalContext`, `stack.override`, and `stack.cacheEnvOverride` declared at user tier with a structured error at load time. The test at `tests/config-server/tools/writes.test.ts:472-493` (which currently expects success on user-tier `additionalContext` writes) flips to expect rejection. See spec revision §7 item 10 (tightened below).
7. **OQ#7 — F3 `path.no_escape` invariant deduplication. RESOLVED (2026-05-02) →** keep `path.escape` (the F2-cataloged code), delete `path.no_escape`. The invariant will continue to raise `PathEscape` per the F2 enum. Code change: delete `src/config-server/invariants/path-no-escape.ts` (or whatever the file is named), remove its registration from the invariants index, delete its test file. See spec revision §7 item 4 (tightened below).
8. **OQ#8 — F2 surface drift acceptance. RESOLVED (2026-05-02) →** F2 absorbs the five extra tools and three extra error codes. They're shipped, tested, and consumed; updating F2 to match is the cleanest reconciliation. See spec revisions §7 items 1 and 2 (already definitive — no rewording needed).

9. **OQ#9 — Platform priority. RESOLVED (2026-05-02) →** macOS is the v1 target; Linux best-effort; Windows out-of-scope.

   **Resolved design:**
   - **macOS** is the v1 release-gate platform. UX, error-text discipline, and bash compatibility (3.2 floor) all assume macOS as the primary user environment.
   - **Linux** is supported on a best-effort basis. Failures on Linux are bugs to fix when noticed, but they don't block releases. Most code paths (POSIX file modes, symlinks, `realpathSync.native`, sync IO) work identically; macOS-specific bash 3.2 constraints are a strict superset of what modern Linux bash handles.
   - **Windows** is explicitly out-of-scope for v1. Symlink permissions, path separator differences, file-mode semantics, and bash availability all diverge enough that committing to Windows would multiply v1 surface area substantially without clear demand. The framework may happen to function on Windows in some configurations but that is not a property the project commits to or tests for.
   - Existing macOS-coupled language stays: PROJECT_CONTEXT.md's "iOS-developer-on-macOS readability check" for user-facing error text, `lint-error-text`'s shell-remediation discipline, and the bash-3.2 floor in `install.sh` are all load-bearing and do not change.

   See spec revisions §7 items 28-30.

## 7. Recommended spec revisions

Each item below cites the spec file, the line range to revise, and the proposed change in 1-2 sentences. Numbered for cross-reference from §3.

1. **F2 `specifications/F2-config-api-contract.md`, lines 49-79 (function tables).** Add the five additional tools to the appropriate tables: `getMergedSplicePoints` and `getStackResolution` to the Reads table; `appendToOverlayField` / `removeFromOverlayField` to the Writes table; `trustList` to the Reads table. (`trustList` could alternatively stay R5-only with a forward-reference note.)
2. **F2 `specifications/F2-config-api-contract.md`, line 127 (error-code enum).** Add `NotImplemented`, `MalformedInput`, `CacheEnvConflict` to the enumerated set. Update the prose to acknowledge `MalformedInput` for tool-input validation, `CacheEnvConflict` for the C1 conflict-resolution scenario.
3. **F2 `specifications/F2-config-api-contract.md`, line 77 + R5 spec line 32.** Change `trustApprove(contentHash, note?)` to `trustApprove(projectRoot, note?)`. The server computes the hash; this matches both safety (no caller hash mismatch) and the implementation.
4. **F3 `specifications/F3-schema-authority.md`, line 84 (`path.no_escape` row). [Direction locked per OQ#7]** Rename the catalogue entry to `path.escape` and note that it raises `PathEscape` (not `InvariantViolation`). **Code-side action:** delete `src/config-server/invariants/path-no-escape.ts` (and its test file), remove its registration from `src/config-server/invariants/index.ts`. The shared "is this canonical path a descendant of canonical root" helper consolidates with `path-escape.ts`.
5. **F3 `specifications/F3-schema-authority.md`, lines 11-25 (Schema authoring).** Mention `schemas/api-tools-v1.json` alongside `stack-v1.json`, `overlay-v1.json`, `module-manifest-v1.json`. One sentence.
6. **F4 `specifications/F4-threat-model-and-trust.md`, line 138 (`strict` mode row).** Clarify wording: replace "validateAll() succeeds for read-only purposes" with "`validateAll()` returns the structured `UntrustedOverlay` error (so `gan validate` reports it on stdout and exits non-zero). `/gan` aborts at the validation step." Removes the contradiction noted in §3 F4#1.
7. **C1 `specifications/C1-stack-plugin-schema.md`, lines 8-78 (Parse contract).** Rewrite to describe a single YAML frontmatter block, dropping the "frontmatter + body YAML block" two-block model. Update the example to show a single `---`-delimited block matching the implementation in `tests/fixtures/stacks/js-ts-minimal/stacks/web-node.md`. Move all field definitions into "the YAML frontmatter block".
8. **R3 `specifications/R3-cli-wrapper.md`, line 86-88 (scaffold example).** Change `lintCmd` from an object form to a string form: `lintCmd: "false  # TODO: replace with the lint command"`. Matches the schema and the implementation.
9. **C3 `specifications/C3-overlay-schema.md`, line 12. [Direction locked per OQ#4]** Change `~/.claude/gan/config.md` to `~/.claude/gan/user.md` to match the implementation. Cascade the change to F4 line 148, U2 lines 17/87, C4 line 12. No code change — the implementation already uses `user.md`.
10. **C3 `specifications/C3-overlay-schema.md`, lines 71-75. [Direction locked per OQ#6]** No spec text change needed — the rule stays as written. **Code-side actions:** (a) implement the rejection in `src/config-server/storage/overlay-loader.ts` (or wherever the user-tier load path lives); a user overlay declaring `additionalContext`, `stack.override`, or `stack.cacheEnvOverride` returns a structured error at load time per F2's error model. (b) Update or delete the test at `tests/config-server/tools/writes.test.ts:472-493` which currently exercises user-tier `additionalContext` writes and expects success — it should now expect the structured rejection. (c) Coordinate the F2 error-code addition (this may use an existing code like `MalformedInput` or warrant a new code like `UserOverlayForbiddenField`; the implementer chooses, and §7 item 2's enum update covers either).
11. **C3 `specifications/C3-overlay-schema.md`, line 89-91 (warnings).** Verify the inactive-stack `cacheEnvOverride` warning and the unknown `proposer.suppressSurfaces.<stack>.<surface-id>` warning are implemented; if not, either implement or note as deferred.
12. **C4 `specifications/C4-three-tier-cascade.md`, lines 107-108.** Delete or rewrite. The current AC contradicts C3 line 61 and C4 line 28 (`stack.override` is project-only). Replace with an AC that uses a non-project-only field (e.g. `runner.thresholdOverride`) or remove entirely.
13. **C5 `specifications/C5-stack-file-resolution.md`, lines 9-13.** Standardise tier names to `project | user | builtin` (matching code). Mirror in F2's prose where it discusses tier provenance.
14. **R1 `specifications/R1-config-mcp-server.md`, lines 13-39 (repository layout).** Add `trust/`, `validation/`, `logging/`, `scaffold-banner.ts`, `schemas-bundled.ts` to the layout block. These are real subdirectories shipped by R1 + R5.
15. **R2 `specifications/R2-installer.md`, line 21.** Add a one-sentence note: "Until `@claudeagents/config-server` is published, `install.sh` runs `npm install -g .` from the repo root (per the local-install-only rule documented in PROJECT_CONTEXT.md)."
16. **Banner text canonicalisation. [Direction locked per OQ#2 — LONGER form wins]** The canonical banner is `# DRAFT — replace TODOs and remove this banner before committing.` (matches PROJECT_CONTEXT.md line 169 and R3 line 65 already). Update everything that uses the shorter form:
    - **Spec text changes:** R3 line 32, R4 line 48, F3 line 89.
    - **Code change:** `src/config-server/scaffold-banner.ts` — update the `DRAFT_BANNER` constant value from `"# DRAFT — replace TODOs before committing."` to `"# DRAFT — replace TODOs and remove this banner before committing."`.
    - **Test fixture change:** `tests/fixtures/stacks/invariant-stack-draft-banner/stacks/web-node.md` — update line 14 (`# DRAFT — replace TODOs before committing.`) to the new text.
    - **Test assertion changes:** `tests/config-server/invariants/stack-no-draft-banner.test.ts` line 48 currently asserts `expect(issue.message).toContain('replace TODOs before committing')`. The new banner text doesn't contain that substring verbatim (because of the inserted "and remove this banner"). Update the assertion to either `toContain('replace TODOs')` AND `toContain('remove this banner')`, or to match the full new banner text.
    - **R4 lint-stacks fixtures:** `tests/fixtures/scripts/lint-stacks/draft-banner/stacks/web-node.md` (and any other fixture that bakes in the banner literal) updates to the new text.
    - **The SECOND_LINE in `src/cli/lib/scaffold.ts`** (`"# `gan validate` and CI's lint-stacks will fail while this banner is present."`) **stays unchanged** — it's a scaffold-only annotation following the banner; it's not what the invariant checks. Document its role in scaffold-only commentary in R3's "Scaffold contract" section so future maintainers don't think it's part of the banner constant.
17. **R3 `specifications/R3-cli-wrapper.md`, lines 117-127 (exit-code table).** Expand to enumerate every F2-error-code → exit-code mapping (matching `src/cli/lib/exit-codes.ts:26-45`). Currently 7 rows; expand to ~15.
18. **R3 `specifications/R3-cli-wrapper.md`, line 86-88 (scaffold example).** Same as item 8.
19. **R4 `specifications/R4-maintainer-tooling.md`, lines 52-56 (publish-schemas).** Soften the wording from "re-extracts and writes" to "validates the on-disk copy against the spec source and exits non-zero on drift". The v1 script does drift-check; spec-extraction is a `TODO(future)`.
20. **R5 `specifications/R5-trust-cache-impl.md`, line 32.** Same as item 3 — change `trustApprove(projectRoot, contentHash, note?)` to `trustApprove(projectRoot, note?)`.

### Items 21-27: resulting from OQ#5 resolution (built-in stack distribution model)

21. **C5 `specifications/C5-stack-file-resolution.md`, lines 9-13 (three-tier list).** Replace the current tier 3 (`<repo>/stacks/<name>.md` — built-in defaults shipped with ClaudeAgents.) with: `<packageRoot>/stacks/<name>.md` — built-in defaults shipped with ClaudeAgents, read directly from the framework's npm install location (resolved at server startup via the same `import.meta.url` walk-up R1 uses to find its own `package.json`). Add prose noting that the previous `<projectRoot>/stacks/` model is dropped because it had no coherent end-user mental model (the user's project root is not the framework's repo).

22. **C5 `specifications/C5-stack-file-resolution.md`, new sub-section after the three-tier list.** Add a "User-facing path conventions" paragraph noting: the resolver reads tier 3 from `<packageRoot>/stacks/`; for user inspection convenience, `install.sh` symlinks `~/.claude/gan/builtin-stacks/` to that location so the canonical user-facing handle is `~/.claude/gan/builtin-stacks/<name>.md`.

23. **R3 `specifications/R3-cli-wrapper.md`, "Subcommand surface" table (lines 22-39).** Add four new commands: `gan stacks available [--json]` (list stacks the framework ships), `gan stacks customize <name> [--tier=project|user]` (vendor a built-in into the user's chosen customization tier so it can be edited; refuses to overwrite without `--force`), `gan stacks reset <name> [--tier=project|user]` (delete the customization-tier copy, restoring the built-in default), `gan stacks where [<name>]` (print the resolved path of the built-in stacks directory or a specific stack file). Clarify in adjacent prose that `gan stacks list` reports **active** stacks (per detection), distinct from `available` (offered by framework) and `installed` (vendored at customization tier).

24. **R3 `specifications/R3-cli-wrapper.md`, line 31 (`gan stacks new` flag set) and line 105 (`--tier=repo` paragraph).** Drop the `--tier=repo` flag value entirely. Maintainers authoring new built-in stacks edit the framework repo's `stacks/` source tree directly; there is no longer a meaningful "repo tier" destination from the end-user CLI's perspective.

25. **R2 `specifications/R2-installer.md`, "What `install.sh` does" section.** Add a step after `npm install -g .` succeeds: create symlink `~/.claude/gan/builtin-stacks` → `<packageRoot>/stacks/`. Idempotent (replace existing symlink in place; refuse and abort if a real directory or file exists at that path). Recorded in `STATE_LOG` for rollback. Removed by `install.sh --uninstall`. Skipped silently on Windows (out of v1 scope per OQ#9).

26. **F1 `specifications/F1-filesystem-layout.md`, zone 1 description.** Add a note that `~/.claude/gan/builtin-stacks/` is a managed symlink to the framework's npm-installed `stacks/` directory; it appears under zone 1 for user-visibility convenience but is read-only from the user's perspective and managed by `install.sh`. Project-tier customization remains at `<projectRoot>/.claude/gan/stacks/` and user-tier customization at `~/.claude/gan/stacks/`.

27. **R4 `specifications/R4-maintainer-tooling.md`, `lint-no-stack-leak` "Where they're allowed" section (lines 87-94).** Drop the `<projectRoot>/stacks/<name>.md` carve-out — that path is no longer a runtime lookup site under the new model. The fixture-tree carve-outs (`tests/fixtures/stacks/js-ts-minimal/`, `tests/fixtures/stacks/polyglot-webnode-synthetic/`) stay as-is; tests use the fixture-as-tiny-repo pattern which still has each fixture's own `stacks/` directory at fixture root. Add a one-line note: built-in stacks now live in node_modules and are not in the lint script's scan scope by default.

   Also revise **E2 `specifications/E2-builtin-stack-extraction.md`** to pin the install model: framework ships canonical stacks at `<packageRoot>/stacks/` via the npm `files` array (which gains `"stacks"`); install.sh symlinks them to the user-home alias; never copied eagerly into user projects. The bootstrap step (auto-`gan stacks install --detected` on installer completion) is **NOT** added — the npm-installed-as-source model means defaults are already on the resolver path the moment install completes.

### Items 28-30: resulting from OQ#9 resolution (platform priority)

28. **PROJECT_CONTEXT.md, near the top of the locked-decisions list.** Add a "Platform priority" subsection: *"v1 target platform is **macOS**. **Linux** is supported best-effort — failures are fixed when reported but do not gate releases. **Windows** is explicitly out-of-scope for v1. install.sh targets bash 3.2 (macOS system default); no bash-4 features. Existing macOS-coupled UX rules — the iOS-developer-on-macOS readability check for error text, the no-`npm`/`Node` discipline in user-facing strings — are load-bearing and stay."*

29. **F1 `specifications/F1-filesystem-layout.md`, line 16.** Soften "modelled on the Linux filesystem hierarchy" to "following standard POSIX filesystem conventions" and add a one-sentence pointer to PROJECT_CONTEXT's Platform priority section.

30. **R2 `specifications/R2-installer.md`, line 9.** Specify the bash floor: change "Bash, POSIX-compatible" to "Bash 3.2-compatible (the macOS system default; avoids bash-4 features like associative arrays, `mapfile`, `${var,,}`). POSIX-compatible." Note that the existing `install.sh` already conforms; this is documentation, not a code change.

---

End of audit. None of the findings block Phase 3 starting. **All nine open questions have been resolved during user review on 2026-05-02** — see §6 for the resolutions and §7 for the resulting spec/code revisions. Items 4, 9, 10, and 16 were tightened from "either/or" to definitive directions per OQ#7, #4, #6, and #2 respectively. The audit gate is now CLOSED pending implementation of the approved revisions.

**Implementation phase next.** The 30 approved revisions are a mix of spec edits (the majority — straight markdown changes), code changes (path-escape dedup; banner constant update; user-tier-forbidden enforcement; CLI surface additions for OQ#5; install.sh symlink step; package.json `files` array for E2 prep), and test changes (banner-text fixture updates; user-tier `additionalContext` test inversion; new tests for the new CLI surfaces). A typical execution would batch them into 3-5 spec-revision commits + 2-4 code-and-test commits, gated as usual by the spec-validator → contract-negotiator → generator → discriminator pipeline for any code-touching changes.
