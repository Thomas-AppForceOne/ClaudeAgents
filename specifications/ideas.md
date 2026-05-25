# Ideas

Parking lot for future-work ideas that haven't been promoted to specs yet. Anything here is unscoped — a sketch of intent, not a commitment. Promote an entry to its own file under `specifications/` (or to `specifications/deferred/` if authored but postponed) once it's worth real design work.

**Each entry** carries: a short title, one-paragraph motivation, a sketch of how it might work, open questions, and a status line. Keep entries short — if it grows past ~30 lines, it's ready to be a real spec.

**Statuses:** `idea` (raw thought), `interested` (likely worth doing), `scoping` (someone is actively designing).

---

## 1. `--spec <url>` — external sources as spec input

**Status:** idea · **Added:** 2026-05-11

### Motivation

Today `--spec` accepts only a local file path. Users who track work in Jira / GitHub Issues / Linear / Asana have to manually pull the ticket, save the content to a file, then run `/gan --spec <file>`. With the relevant MCP servers installed in Claude Code, the orchestrator already has a way to fetch that content — the two-step workflow is friction without a payoff.

### Sketch

1. **URL detection** — if `--spec` value matches `^https?://`, branch to a URL-fetch path instead of file-read.
2. **Fetcher selection** — match the URL host against known MCP-handled patterns:
   - `*.atlassian.net/browse/*` → Jira MCP `get-issue`
   - `github.com/*/issues/*` → GitHub MCP
   - `linear.app/*/issue/*` → Linear MCP
   - Fallthrough → built-in `WebFetch`.
3. **Persist** — write the fetched content to `.gan-state/runs/<run-id>/raw-spec.md` before handing off to the planner. The original URL is recorded in `progress.json` for the audit trail; the planner reads from the persisted file (same path as today). This keeps the spec immutable across the run.

### Open questions

- Authentication for private Jira / GitHub instances — does the MCP carry creds, or does the orchestrator need to surface a remediation hint when the fetch returns 401/403?
- HTML vs. prose: Jira issue bodies are typically Atlassian Document Format or HTML. Who normalises that to markdown the planner can consume — the MCP, or a transformer step in the orchestrator?
- Fallback policy when the matched MCP isn't installed: silently use `WebFetch`, or refuse with an explicit "install the X MCP for better results" hint?
- Should fetched URLs be re-fetchable on `--recover` (the URL might have moved), or does the persisted `raw-spec.md` win to keep recovery deterministic? Probably the latter.
- Cache: re-running `/gan --spec <same-url>` shouldn't re-fetch within some short window. Where does that live — `.gan-cache/`?

### Likely target spec

A new `U4-external-spec-sources.md` under the U-prefix (user-experience surfaces), or an amendment to `E5-spec-clarification.md`. About 1 spec sprint to author, 1–2 to implement (SKILL.md + planner agent + integration tests with mocked MCP responses).

---

## 2. Repository-level secret scanning (gitleaks / GitHub secret-scanning)

**Status:** idea · **Added:** 2026-05-11

### Motivation

The framework currently has no real secret-detection check on its own repository. The `lint-no-stack-leak` script's name reads like a security check at first glance but is purely an architecture-discipline guard (ecosystem-token retargetability). The evaluator-core helper at `src/agents/evaluator-core/secrets-scans.ts` produces file lists per stack's `secretsGlob`, but the actual content scan for secret patterns (AWS keys, GitHub PATs, private keys, etc.) happens at the agent layer, not via a deterministic scanner. A `.env` accidentally committed to this framework's own repo would land without alarm.

### Sketch

Two layers, both gated on real pattern-matching, not glob-shape:

1. **CI gate** — add `gitleaks` (Apache 2.0; runs as a single Go binary) as a workflow under `.github/workflows/test-secrets.yml`, hooked to `pull_request` and `push` to `main`/`develop`. Failure blocks merge. Same shape as the existing `test-no-stack-leak.yml`. Configure via a checked-in `.gitleaks.toml` listing allowlisted strings (test fixtures with intentionally-fake secrets, e.g. `tests/fixtures/.../trust-cache-stub.json`).

2. **Pre-commit hook (optional, opt-in)** — a `gitleaks protect --staged` invocation wired through `.husky/` or `lefthook.yml`. Catches secrets before they leave the user's machine. Opt-in because the framework currently has no pre-commit hook infrastructure of its own.

Bonus consideration: extending the evaluator-core's `secrets-scans.ts` from "list files to scan" to "list files plus pattern set" so the evaluator agent calls gitleaks or trufflehog on the generated worktree rather than running an LLM-judged check. Deterministic, faster, and the result is a structured finding the evaluator can include in feedback verbatim.

### Open questions

- Allowlist authoring vs. `forbidden.json` style: gitleaks uses TOML allowlists with regex; the framework's existing lint scripts use JSON allowlists with path keys. Different shape; do we standardise or keep them separate?
- False-positive cost: secret-pattern scanners flag things like UUIDs and bcrypt hashes. Do we tune for low recall (only the high-confidence patterns) to avoid noise, or accept some noise as the price of safety?
- Should GitHub's native secret-scanning (free for public repos) be enabled as a belt-and-braces second layer? It's set-and-forget at the org level; no repo changes needed.
- For the evaluator extension: do we ship gitleaks as a hard dependency of the framework, or invoke it via a `securityScanCmd` splice point in the active stack so each ecosystem can pick its own scanner (gitleaks, trufflehog, detect-secrets, etc.)?

### Likely target spec

A new `F5-secret-scanning.md` under the F-prefix (foundational/framework-wide surfaces), or an amendment to `F4-threat-model-and-trust.md`. About 1 spec sprint to author, 1 to wire the CI gate, 1 to land the evaluator-core extension if scoped in.

---

## 3. Multi-stack doc-lint: language profile (data) + neutral core (library), never stack-injected code

**Status:** idea · **Added:** 2026-05-25

**TL;DR:** Q6 shipped `scripts/doc-lint/` TypeScript-only. To cover other stacks without rewriting the tool per language, split it three ways and keep all per-language knowledge as **data** or a **trusted subprocess** — never as executable code a stack injects.

### Motivation

`docLintCmd` already lets a stack name *any* command, and the evaluator wiring (`buildDocLintInvocations`) is fully stack-agnostic — so the integration path needs no framework change. The cost is concentrated entirely in the linter behind the command. But that cost is smaller than it looks: the engine's git/delta/grandfather/`--require-base`/severity/report machinery is **already language-neutral**; only ~6 symbols (the glob list, export regexes, doc-comment association, the two advisory collectors) are TypeScript-bound, and most of *those* are data, not logic.

### Sketch — the three-way split

- **Presence rule (the only gating rule) → declarative `LanguageProfile`** in stack front-matter: file globs, export-detection regex(es), a `visibility` enum (keyword `export`/`pub` | capitalized | underscore-private), doc-comment delimiter + position (`above` | `docstring-below`). Pure data, schema-validated, fits the existing stack/trust model. Adding a language's *gate* becomes config.
- **Tag-shaped advisories** (required-sections, commented-out-code) **→ also data:** their algorithms are already neutral; only the regex tables differ (`@param`/`@returns`, code-looking patterns). Carry them in the profile as regex lists.
- **Structurally-divergent advisories** (e.g. Python docstrings live *inside* the body as prose, not as tags above) **→ delegate to the ecosystem's real linter** via the existing `docLintCmd` string (ruff/pydocstyle, revive). Don't reimplement.
- **Code reuse for tool authors → ship the neutral core as an importable library;** keep framework→tool a subprocess.

### The load-bearing constraint

**Never let a stack ship an *executable* heuristics module.** Stacks are declarative data gated by the trust protocol (F4/F6); a loadable module = arbitrary code running in `/gan` and CI, a supply-chain surface, a versioned engine↔module API, and a trust model that must now cover code execution. This is exactly why `docLintCmd` is a subprocess string, not a plugin — the subprocess *is* the trust boundary. The whole idea works only because the heuristics arrive as data or as a separately-trusted command.

### Open questions

- Profile home: inline in each stack's front-matter, or a shared `profiles/` referenced by name? (Schema impact either way.)
- Do the `visibility` / doc-position enums stay a closed set, or will a language force a new variant? (Escape hatch is always `docLintCmd` delegation.)
- Neutral core: published as an npm package, or vendored — given consumer ecosystems may not be on Node?
- The regex-table approach inherits TS's accepted false-negative ceiling (re-exports/destructuring) per language; where does that push a language straight to a real external linter instead of a profile?

### Trigger / likely target spec

Extract the profile against the **second concrete language**, not before — factoring an abstraction from one example bakes in TS assumptions. A new Q-series spec (e.g. `Q7-doc-lint-language-profiles.md`) reusing C1's stack-schema discipline; ~1 spec sprint to author, ~1–2 to extract the core once, then each new language is config.
