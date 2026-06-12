# H4 — Confinement-hook artifact parity

## Problem

The framework-owned PreToolUse confinement hook (H1, rewritten by F7) carries a hand-maintained allowlist of run-dir artifact filenames (`scripts/hooks/gan-confine.sh.template`, the `case "$REL"` block). That list was written for the pre-E5/pre-E8 artifact set and was never updated when later specs added artifacts. The installed hook today **denies** every artifact the clarification and review stages must write:

- `clarified-spec.md`, `clarified-spec.md.round-N`, `raw-prompt.md` (E5; SKILL.md clarification phase),
- `spec.md`, `plan.md` (planner outputs),
- `sprint-{N}-independent-review-{attempt}.json` (E8's reviewer bundle),
- the contract-reviewer verdict file (consumed by E10),
- `sprint-{N}-contract.r{k}.json` archive siblings and `sprint-{N}-contract.draft-tmp.<token>.json` partial drafts (E8's re-lock lifecycle — the orchestrator writes the draft-tmp file with the `Write` tool before invoking `relockContract`).

Verified by live probe (2026-06-12, develop @ 68c4cb5): all of the above exit 1 ("outside the run's allowed zones"); only `progress.json`, `sprint-1-contract.json`, and `sprint-1-feedback-A.json` exit 0. This is the primary cause of `/gan` runs dying at the first sprint's review stage: the agents either fail their mandated writes or improvise non-canonical paths/channels, and the orchestrator stalls or burns attempt ceilings (see [`_audit-2026-06-12-structural.md`](_audit-2026-06-12-structural.md)).

The structural defect under the incident: **the run-artifact inventory has no single home.** Artifact names are scattered across SKILL.md, five agent prompts, the hook template, the `evaluator-evidence-bundle-v1` join-key prose, and O2's recovery dispatch — so adding an artifact in one place and forgetting the hook is the default failure mode, and nothing in CI catches it (every E8-era artifact shipped with green CI).

### Five-question relevance filter

1. **Plugs into existing primitives?** Yes — extends H1's hook and F7's template; adds one catalog module the hook test and later lints (F9, Q8) consume.
2. **Composable?** Yes — F9 keys schema-gated writes off the same catalog; Q8's prompt-parity lint reads it; future specs add artifacts by editing one file.
3. **Owns durable structured state?** No new state — it governs the existing zone-2 artifact namespace.
4. **Fits existing lanes?** Yes — single point of implementation (the catalog), same pattern as the invariant catalog and the determinism pins.
5. **Stackable?** Yes — every future artifact-introducing spec lands one catalog row.

## Proposed change

### 1. Run-artifact catalog — one fact, one home

New module `src/run-artifacts/catalog.ts`, exported from the package root (dual-callable surface rule). It is the **authoritative inventory of every artifact path the framework writes under `GAN_RUN_DIR`**:

```ts
export interface RunArtifact {
  /** Bash-glob arm as it appears in the hook template, e.g. "sprint-[0-9]*-independent-review-[0-9A-Za-z]*.json" */
  hookPattern: string;
  /** Human-readable canonical form, e.g. "sprint-{N}-independent-review-{attempt}.json" */
  canonicalForm: string;
  kind: 'json' | 'markdown' | 'text' | 'subtree';
  writer: 'orchestrator' | 'gan-clarifier' | 'gan-planner' | 'gan-contract-proposer'
        | 'gan-contract-reviewer' | 'gan-generator' | 'gan-evaluator'
        | 'gan-reviewer-independent' | 'config-server';
  /** Bundled schema id when kind === 'json' and a schema exists, e.g. "independent-review-v1" (consumed by F9). */
  schemaId?: string;
}
export const RUN_ARTIFACTS: readonly RunArtifact[];
```

Seed contents: the eight patterns the template allows today **plus** `clarified-spec.md`, `clarified-spec.md.round-[0-9]*`, `raw-prompt.md`, `spec.md`, `plan.md`, `sprint-[0-9]*-independent-review-[0-9A-Za-z]*.json`, `sprint-[0-9]*-contract-review-[0-9]*.json` (E10's verdict file — the arm ships here so E10 is not blocked on a hook release), `sprint-[0-9]*-contract.r[0-9]*.json`, and `sprint-[0-9]*-contract.draft-tmp.*.json`.

**Deliberately excluded:** the legacy `evaluator-logs/` and `evaluator-logs-B/` sidecar names (BR-012) stay denied — exclusion is the enforcement mechanism that retires them.

### 2. Hook template parity

`scripts/hooks/gan-confine.sh.template`'s `case "$REL"` block gains one arm per catalog row (hand-written — the template stays a dependency-free bash script; parity is enforced by test, not by generation). The template's hook-version constant is bumped so H3's `probeConfineHook` staleness detection flags out-of-date project-tier copies, and `install.sh` re-renders the user-tier hook on the next run as it already does on every install.

### 3. Parity tests (the recurrence guard)

New vitest suite `tests/hooks/artifact-parity.test.ts`:

- **Allow-parity:** for every catalog row, render the template (the same render path install.sh uses), set `GAN_RUN_ID`/`GAN_WORKTREE`/`GAN_RUN_DIR` to fixture paths, pipe a synthetic PreToolUse JSON for a representative expansion of `hookPattern` under `GAN_RUN_DIR`, and assert exit 0. Representative expansions are derived mechanically (digits → `1`, attempt letters → `A`, `<token>` → `tok`).
- **Deny-spot-checks:** `evaluator-logs/x.log`, a dot-dot escape, a path under `~/.claude/`, and an uncatalogued JSON name (`sprint-1-banana.json`) all exit 1.
- **Template-arm completeness:** the test greps the template and asserts every `hookPattern` string appears verbatim as a case arm, so a catalog edit without a template edit fails red, and vice versa.

This suite rides the existing test harness (no new CI workflow file; Q8 later adds the prompt-side parity lint that closes the remaining direction — prompts naming artifacts the catalog lacks).

## Schema additions

None. The catalog is a TS module (re-exported per the dual-callable surface rule), not a JSON schema; `schemaId` values reference existing bundled schemas. F9 consumes the catalog for write-time validation; this spec does not change any write path.

## Acceptance criteria

1. **Live-probe parity.** With the freshly installed user-tier hook, the reproduction commands in [`_audit-2026-06-12-structural.md`](_audit-2026-06-12-structural.md) § "Root cause" exit 0 for every catalogued artifact and the deny-spot-check paths exit 1.
2. **Catalog is the single home.** `RUN_ARTIFACTS` exists, is exported from the package root, and contains every artifact filename mentioned in `skills/gan/SKILL.md` and `agents/*.md` (manually verified in this PR; mechanised by Q8).
3. **Parity tests red-on-drift.** Deleting any single case arm from the template makes `tests/hooks/artifact-parity.test.ts` fail; adding a catalog row without a template arm fails the completeness assertion.
4. **Hook-version staleness fires.** The template version constant is bumped; `probeConfineHook` against a pre-H4 project-tier hook copy reports stale (H3's existing verdict vocabulary, no new surface).
5. **Legacy names stay denied.** `evaluator-logs/*` paths under `GAN_RUN_DIR` exit 1, asserted by test.
6. **No prompt edits required.** This spec changes no agent prompt and no SKILL.md prose except none at all — if an artifact name in a prompt disagrees with the catalog's canonical form, that is an E10/F9 concern, recorded there.

## Version bump: minor

The catalog ships in the installed package (`dist/`), and the hook template ships under `scripts/hooks/` consumed by `install.sh` at render time. Per the install-version bump discipline, the implementation PR minor-bumps `package.json` so `version_probe_mcp` re-installs and the new hook + catalog reach dogfooding machines.

## Dependencies

- **H1 / F7 / H3** (shipped) — the hook, its template home, and the staleness probe this spec extends. Cross-referenced, never edited.
- **E8 / E5 / O2** (shipped) — the specs whose artifacts the catalog inventories; their filenames are adopted verbatim.
- **E10** (forward) — the contract-review verdict filename is reserved here (`sprint-{N}-contract-review-{k}.json`) and specified there; coordinated by name only.

## Bite-size note

One sprint, one PR: catalog module + template arms + parity tests + version-constant bump. No agent or SKILL.md edits. This is deliberately the smallest possible unbreaking change; everything that *moves* writes onto new paths (F9) or wires new consumers (E10) is downstream.
