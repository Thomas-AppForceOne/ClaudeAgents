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

---

## 4. Post-run external documentation generation (markdown + mermaid)

**Status:** interested · **Added:** 2026-05-25

**TL;DR:** After a GAN run, generate/update *external* technical docs (markdown + mermaid diagrams — like this repo's own `documentation/` folder), not in-code doc comments. Optional per-stack **documentation module**, configured via the existing default→user→project overlay; runs only if present *and* configured. Incremental by default: assume existing docs are current, touch only what the run changed.

### Motivation

Today's `documentationSurfaces` *enforce* docs (proposer instantiates criteria, evaluator scores them) but generate nothing, and they target in-code comments. External architecture docs — the high-value, human-onboarding kind — are exactly what nobody keeps current. A GAN run already knows precisely what it changed, so it's well placed to emit the matching doc delta. The repo's six hand-authored mermaid subsystem files are the reference output / dogfood target.

### Sketch

1. **Optional per-stack documentation module** — declares *what artifacts* and *at what depth* (e.g. web-node → route/component graphs; python → module/dependency graphs). Optional: a stack may ship without it. Resolved through the existing overlay cascade (default→user→project); executes only if present and configured.
2. **Incremental update** — bootstrap = full generation (or existing hand-authored docs as seed); thereafter touch only the artifacts the run's diff affects. Reuse the existing `documentationSurfaces` `triggers: { keywords, scope }` model to map a sprint's diff → affected doc artifacts (a reuse, not new infra).
3. **Structural gate, not semantic** — before docs are accepted: mermaid parses, and every node/edge references a file/module/symbol that still exists (catches dangling refs after rename/delete). Semantic accuracy ("is this the *right* abstraction") is explicitly best-effort — the one artifact class gated structurally only.
4. **New post-run phase** owned by the orchestrator (no post-run extension point exists today).

### Open questions

- **Compounding drift is the core risk.** Incremental gives up the self-correction that wholesale regen provides — a wrong edge in run 5 is inherited by runs 6–50. Mitigation: a **periodic full-regen backstop** to scrub accumulated drift. How often / what triggers it?
- **Silent under-update** is the nasty failure mode: a local code change ripples into a system-level diagram that the trigger mapping misses. How conservative should the diff→artifact mapping be (over-touch costs tokens; under-touch costs accuracy)?
- **Cost** — even incremental, doc gen is token-heavy. Gate on "only if scope X changed", or offer an on-demand mode?
- **Generate + evaluate as a mini-loop?** Should doc gen be a true generator phase the evaluator then scores (consistent with the framework's "nothing unverified ships" DNA), or a lighter post-run step with only the structural gate?
- Surgical mermaid edits are fiddly for an LLM (preserving untouched parts) — regenerate-per-artifact vs. true in-place edit?
