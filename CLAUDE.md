# ClaudeAgents — Claude Code guide

ClaudeAgents is a generator-discriminator framework for AI-driven software development (the `/gan` loop). **This repo is the framework itself.** The contents of `agents/` and `skills/gan/` are the **shipped product** that runs against end-user repos — never put repo-internal process (e.g. references to this repo's `specifications/roadmap.md`) into them; `lint-no-stack-leak` and `test-error-text` police the ecosystem-token and error-text parts of that boundary, and `lint-no-spec-ref` (introduced by D2) closes the spec-reference part. Until D2 ships, `SKILL.md` still carries live `specifications/*` references — that residual leak is exactly what D2 removes.

## Read these first

- **[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)** — authoritative for **conventions** (how we work): spec immutability, schema discipline, the five-question relevance filter, retirement rules, the do's and don'ts. Read it before implementing anything. Single-writer rule: only spec-validator writes it; everyone else reads.
- **[specifications/roadmap.md](specifications/roadmap.md)** — authoritative for **order** (what ships next; the v1.0 implementation order).
- **Each spec file under `specifications/`** — authoritative for what that spec governs.

## Definition of done for a spec implementation

A spec's implementation PR also flips that spec's entry in `specifications/roadmap.md` § "Implementation order" to the shipped form (`✅ **<spec>** — <desc>. Shipped PR #<n>`) in the **same diff** — a merged spec whose roadmap entry still shows a link, a `**Next.**` marker, or no `✅` is a defect. Shipped specs are otherwise immutable: new behaviour goes in a new spec, never an edit to a shipped one.

Full rules and rationale live in PROJECT_CONTEXT § Conventions — "Shipping a spec flips its roadmap entry", "Implemented specs are immutable", "One fact, one home". (Status itself is never tracked here or in PROJECT_CONTEXT; the roadmap is its only home.)
