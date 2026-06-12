# F9 — Schema-gated run-artifact write boundary

## Problem

Every JSON artifact under `GAN_RUN_DIR` is written by an LLM (orchestrator or agent) through the generic `Write` tool, with conformance existing only as prose instructions. The verified bug-report corpus shows what that buys: review bundles in four shapes across five artifacts with two runs completing `terminalReason: "success"` on malformed sprint-1 bundles (BR-002), `progress.json` key-sets diverging across all eight runs because direct orchestrator writes bypass the schema-gated MCP tools (BR-003), generator objections dead-lettering with no schema or handler (BR-005), and `schemaVersion` stamps that — where present — would *fail* validation against their own schemas (BR-016). The shared root cause, named by the BR verification pass: **"per-call-site obedience, not global wiring."** Schemas exist; nothing enforces them at the only place enforcement is possible — the write boundary.

H4 gives every artifact one catalog row; E10 gives the last unwired artifact a consumer. This spec makes the catalog *enforcing*: a single sanctioned write channel that validates before bytes hit disk, so a malformed artifact becomes a structured error at write time instead of a silent time bomb at read time.

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — one new Configuration-API-style MCP tool over H4's catalog and the existing bundled-schema set; reuses `atomicWriteFile` and the F2 error factory.
2. **Composable?** Yes — every future artifact gets validation by adding a catalog row + schema; O4's recovery guards and Q2's taxonomy read artifacts this spec makes trustworthy.
3. **Owns durable structured state?** Yes — it owns the *integrity* of all zone-2 run artifacts.
4. **Fits existing lanes?** Yes — the black-box API rule ("agents call functions, never parse files") extended to writes; the same dual-callable surface and error-factory rules as every R1 tool.
5. **Stackable?** Yes — the hook-tightening phase composes with H4; F9 is the substrate the "gates that bite" family builds on.

## Proposed change

### 1. `writeRunArtifact` MCP tool

New tool (dual-callable, registered in the dispatch table and `api-tools-v1.json`):

`writeRunArtifact({ runDir, name, content })`:

- Resolves `name` against H4's `RUN_ARTIFACTS` catalog. An uncatalogued name rejects with the new structured error code **`ArtifactValidationFailed`** (built in `errors.ts`, F2 enum extended) whose message names the offending filename and the catalog home.
- `kind: 'json'` rows with a `schemaId`: parse + validate `content` against the bundled schema **before** writing; on failure, reject with `ArtifactValidationFailed` carrying the ajv error path (`file`/`field`/`line` populated per the F2 structured-error shape). The artifact never lands malformed.
- `kind: 'markdown'` rows (`clarified-spec.md`, `spec.md`, `plan.md`): a section-presence check (the BR-011 option-b lint — required headings per catalog row; for `clarified-spec.md`: `Goal` / `In scope` / `Out of scope` / `Assumptions` / `User actions` / `Constraints`). This retires the phantom "document schema" reference: the section list in the catalog row **is** the validation contract, and E5-descended prose pointing at a nonexistent schema document is rewritten to point here.
- Writes are atomic (`atomicWriteFile`, temp + rename) — which also closes the evaluator-feedback partial-write class that kept O2's malformed-JSON recovery heuristic `[deferred-to-v1.1]` (O4 makes the read-side guard operative on top of this write-side contract).
- Zone discipline unchanged: the tool writes only beneath the supplied `runDir`; path-escape rejected via the existing `path-escape` invariant.

### 2. Prompt rewiring — sanctioned channel becomes the instructed channel

`skills/gan/SKILL.md` and the agent prompts are rewritten so every catalogued **JSON** artifact write goes through `writeRunArtifact` (orchestrator-written artifacts directly; agent-written artifacts via the agent's own granted call — frontmatter additions per E11's grant rule). Markdown artifacts route through the same tool for the section check. `progress.json` stays on its existing sanctioned writers (`seedProgress` / `writeProgressFields` / `recordWorkspace` / `relockContract` / the two terminal-rejection tools); the prompts' remaining *direct* `progress.json` writes are replaced with `writeProgressFields` calls — closing BR-003's bypass.

**Hook tightening (same PR, flag-gated rollout):** with the sanctioned channel instructed everywhere, the confinement hook's case arms for catalogued **JSON** artifact names flip from allow to deny — raw `Write` of a schema-validated artifact is no longer a sanctioned path (MCP writes do not pass through the PreToolUse file-tool matcher, so the channel keeps working). Ships behind a template constant defaulting **on**; the markdown artifacts stay `Write`-allowed in v1 (the orchestrator's interactive editor flow edits `clarified-spec.md` in place).

### 3. Schema completeness + stamp convention (the BR-003/BR-016 sweep)

- **`progress-v1.json` completed:** adds `startedAt`, the `sprints[]` ledger (resolving the two incompatible observed shapes), E10's `negotiationRound`, the full `terminalReason` value set including `failed-contract-rejected`, and a ruling on `snapshot.activeStacks` / `finalCommit` (kept, optional). A graceful-read path (validate, on failure surface a structured warning and treat the run as legacy-unrecoverable rather than crashing) covers the existing non-conforming runs.
- **`generator-objection-v1.json`** (new): the objection artifact BR-005 found dead-lettering gets a schema and a catalog row; SKILL.md gains the consuming branch — `OBJECTION-RAISED` routes the objection to the proposer for a contract revision through E10's negotiation protocol (`pass: "renegotiation"`), bounded by the existing `renegotiationCap`, instead of being treated as a failed attempt.
- **`schemaVersion` stamp convention (BR-016, decided):** bare top-level `schemaVersion: <int>` on every catalogued JSON artifact; added to `progress-v1`, `independent-review-v1`, `evaluator-evidence-bundle-v1`, `contract-review-v1` as **optional** (existing conforming artifacts omit it), written always by `writeRunArtifact`, required in `vN+1` of each. Flagged for spec-validator to fold into PROJECT_CONTEXT § Conventions.
- **`reproductionCommand` pattern (finding 18, decided — no change):** the metacharacter ban stays (it is the safety floor under `validateFindings`' runner). The starvation cost is real but bounded: a finding needing a compound command must instead cite a single existing script/binary invocation, and non-conforming findings continue routing to the advisory tier rather than dropping silently. Recorded here so the decision has a home; revisit with Q2's taxonomy data.

## Schema additions

- `schemas/generator-objection-v1.json` — new, bundled, shape above.
- `progress-v1.json` — additive completeness fields + optional `schemaVersion` (in place, per the additive-stays-`vN` ruling).
- `independent-review-v1.json`, `evaluator-evidence-bundle-v1.json`, `contract-review-v1.json` — additive optional `schemaVersion`.
- `api-tools-v1.json` — `writeRunArtifact` entry (input shape: `runDir`, `name`, `content`).
- F2 error enum + `errors.ts` — `ArtifactValidationFailed`.

## Acceptance criteria

1. **Malformed never lands.** For each catalogued JSON artifact, a fixture write with a missing required field rejects with `ArtifactValidationFailed` (correct `field` path) and leaves no file (and no temp residue) on disk.
2. **Valid round-trips.** Conforming fixtures for every `schemaId` row write successfully, atomically, with `schemaVersion` stamped; re-reading validates.
3. **BR-002 regression test.** The verbatim malformed sprint-1 bundle shape from the BR corpus (`{sprintIndex, attempt, …}`) is rejected; the conforming shape passes.
4. **Markdown section gate.** A `clarified-spec.md` missing `Out of scope` rejects naming the section; the `--skip-clarification` minimal form passes; no prose references a "clarified-spec schema" document anywhere (`grep` AC).
5. **Objection routed.** A fixture objection artifact validates; SKILL.md documents the `OBJECTION-RAISED` → proposer branch; the dead-letter prose ("just another failed attempt") is gone.
6. **Bypass closed.** With the hook-tightening constant on, a raw `Write` of `sprint-1-feedback-A.json` under `GAN_RUN_DIR` is denied (H4 parity-test harness reused); `writeRunArtifact` for the same path succeeds.
7. **Progress writers exclusive.** `grep` over SKILL.md finds no instruction to `Write` `progress.json` directly; all mutations name a sanctioned tool.
8. **Legacy reads survive.** `--list-recoverable` against a fixture store containing a pre-F9 non-conforming `progress.json` lists the run with a legacy warning instead of crashing.

## Version bump: minor

New MCP tool, new + edited bundled schemas, hook-template change — the PR minor-bumps `package.json`.

## Dependencies

- **H4** (hard) — the catalog is the tool's name/schema lookup, and the parity-test harness is reused for the tightening ACs.
- **E10** (hard) — settles the contract-review artifact + `negotiationRound`/terminal-reason values this spec freezes into `progress-v1`.
- **E11** — the grant rule under which agents call `writeRunArtifact`.
- **F2 / R1 / T1 / O2 / E8** (shipped) — error contract, tool surface, trace/recovery semantics; cross-referenced, never edited.

## Bite-size note

Two sprints in one PR or two: (1) tool + error code + schema sweep + unit tests; (2) prompt rewiring + hook tightening + objection branch + regression fixtures. The BR reproduction commands from the verification pass are the dogfood check: re-run them against a fresh `/gan` run and observe empty bug output (the FIX-ORDER-PLAN Phase-1 deliverable, finally mechanised).
