# Feedback-canonical fixture pin (Q10)

Five filename shapes pinned by name only — the file *contents* are placeholder JSON. A future drift in either the evaluator prompt, the orchestrator instruction, or the H1 hook is caught by a fixture diff: the canonical name stays exactly one, and the four refused variants stay refused.

| Filename | Shape | Verdict the H1 hook returns |
|---|---|---|
| `sprint-1-feedback-A.json` | Canonical — what the evaluator prompt, SKILL.md, and the H1 hook agree on. | allow |
| `sprint-1-evidence-A.json` | Original E8-run variant. | deny (named) |
| `sprint-1-evaluator-evidence-A.json` | M4-run variant. | deny (named) |
| `sprint-1-evaluation.json` | O1-run variant. | deny (named) |
| `sprint-N-feedback-A.json` | Literal-`N` form — the canonical *template* shape, never a live filename. | deny (the hook's run-id arm requires `N` to be `[0-9]*`) |

The fixture is read-only documentation; tests that exercise hook behaviour against these names live in `tests/installer/confine-hook-feedback-filename.test.ts`.
