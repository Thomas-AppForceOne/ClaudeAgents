# ClaudeAgents — Claude Code guide

ClaudeAgents is a generator-discriminator framework for AI-driven software development (the `/gan` loop). **This repo is the framework itself.** The contents of `agents/` and `skills/gan/` are the **shipped product** that runs against end-user repos — never put repo-internal process (e.g. references to this repo's `specifications/roadmap.md`) into them; `lint-no-stack-leak` and `test-error-text` police that boundary.

## Read these first

- **[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)** — authoritative for **conventions** (how we work): spec immutability, schema discipline, the five-question relevance filter, retirement rules, the do's and don'ts. Read it before implementing anything. Single-writer rule: only spec-validator writes it; everyone else reads.
- **[specifications/roadmap.md](specifications/roadmap.md)** — authoritative for **order** (what ships next; the v1.0 implementation order).
- **Each spec file under `specifications/`** — authoritative for what that spec governs.

## Definition of done for a spec implementation

When you implement a spec and its PR merges to `develop`, the **same PR** flips that spec's entry in `specifications/roadmap.md` § "Implementation order" to the shipped form — `✅ **<spec>** — <short desc>. Shipped PR #<n>` — dropping the link and rationale to match the already-shipped slots, and moving the `**Next.**` marker to the next un-shipped slot. A merged spec whose roadmap entry still shows a link, a `**Next.**` marker, or no `✅` is a defect (it shipped twice undetected: F5 #14, R6 #16). The roadmap is editable (not a shipped spec), so this edit never trips the immutability rule. Full rule + rationale: PROJECT_CONTEXT § Conventions, "Shipping a spec flips its roadmap entry."

Shipped specs are immutable — new behaviour goes in a new spec or an unimplemented one, never an edit to a shipped spec's prose.
