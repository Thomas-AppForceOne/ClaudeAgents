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
