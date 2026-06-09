# BR-002 — `independent-review-v1.json` schema not enforced at write time

**Status:** Closed — same family as the v1.0 obedience-class known gaps (#3 safety-obedience, #4 trace-emission fidelity). Schema-conformance of LLM-emitted artefacts is the same family of problem — Claude can ignore SKILL.md and the agent prompt — owned by the same release-gate-class workstream as BR-001, not this fix plan. See [FIX-ORDER-PLAN.md](FIX-ORDER-PLAN.md) Phase 0.
**Severity:** Blocker
**Found in run(s):**
- `workshop-site-71c837164a90/runs/20260606T195320-b600/sprint-1-independent-review-A.json` (violates v1 schema; uses `sprintIndex`/`attempt` instead of required `sprintNumber`/`attemptLetter`)
- 4 distinct top-level shapes observed across 5 independent-review artifacts (see Reproduction)
**Filed:** 2026-06-08

## Description

E8 shipped `schemas/independent-review-v1.json` with `required: ["sprintNumber", "attemptLetter", "contractRevision", "findings", "summary"]` and `additionalProperties: false`. The reviewer is supposed to author bundles conformant to this schema; ajv-strict validation should reject non-conforming files.

In production, the schema is **not enforced at the orchestrator-write boundary**. The workshop-site run wrote a top-level shape `{sprintIndex, attempt, contractRevision, findings, summary}` — `sprintIndex` and `attempt` are not declared in the schema; `sprintNumber` and `attemptLetter` are required and missing. The file would fail `ajv.validate(independentReviewV1, doc)` immediately, yet the orchestrator accepted it and the renegotiation loop proceeded.

Four distinct shapes observed across 5 runs:
- `{sprintNumber, attemptLetter, contractRevision, findings, summary}` — canonical
- `{contractRevision, findings, summary}` — missing required fields entirely (M4)
- `{sprintIndex, attempt, contractRevision, findings, summary}` — workshop-site, schema-incompatible field names
- `{commitSha, contractRevision, findings, schemaVersion, summary}` — D1 run

Downstream consumers cannot deserialize these against the published schema. The schema is, in effect, documentation only.

## Steps to reproduce

```bash
# Confirm published schema requires sprintNumber + attemptLetter
python3 -c "
import json
s = json.load(open('/Users/taa/AppForceOne/projects/ClaudeAgents/schemas/independent-review-v1.json'))
print('Required:', s['required'])
print('Properties:', list(s['properties'].keys()))
print('additionalProperties:', s.get('additionalProperties'))
"
# Expect: Required: ['sprintNumber', 'attemptLetter', 'contractRevision', 'findings', 'summary']

# Confirm workshop-site violates it
python3 -c "
import json
d = json.load(open('/Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/sprint-1-independent-review-A.json'))
print('Top-level:', sorted(d.keys()))
"
# Expect: ['attempt', 'contractRevision', 'findings', 'sprintIndex', 'summary']

# Validate it with ajv — should fail
node -e "
const Ajv = require('ajv');
const ajv = new Ajv({strict: true});
const schema = require('/Users/taa/AppForceOne/projects/ClaudeAgents/schemas/independent-review-v1.json');
const data = require('/Users/taa/.gan-runs-data/workshop-site-71c837164a90/runs/20260606T195320-b600/sprint-1-independent-review-A.json');
const v = ajv.compile(schema);
console.log('valid:', v(data));
console.log('errors:', v.errors);
"
```

## Root cause (if known)

The schema is bundled (per BR's sprint-1 evidence in run `5cc0`, `src/config-server/schemas-bundled.ts` exports it correctly), but no write-time validation step exists on the path between the reviewer agent's output and disk. SKILL.md likely instructs "write the bundle" without "validate, then write."

## Suggested fix

Wrap every orchestrator-side artifact write through a validator: `writeArtifact(path, schema, doc)` that calls `ajv.validate(schema, doc)` and throws a structured `SchemaViolation` error on failure. Apply uniformly to `independent-review-v1`, `evaluator-evidence-bundle-v1`, `overlay-v1`, and the new `progress-v1` (BR-003).

---

## Verification update (2026-06-08)

**Verdict:** confirmed
**Confidence:** high
**Verification report:** [BR-002-verification.md](BR-002-verification.md) (sonnet)

Reproduction matches verbatim. 5 of 10 artefacts fail strict validation across 4 distinct shapes; two runs with malformed sprint-1 bundles completed with `terminalReason: "success"`/`"complete"`. Refinements:

- **Additional violation class not enumerated.** Two artefacts (`e220/sprint-1-B`, `1588/sprint-2-A`) fail validation on the `reproductionCommand` safety `pattern`, not on missing fields.
- **`validateFindingsTool` only partially mitigates.** Its `UNSAFE_COMMAND_CHARACTERS` regex catches shell-metacharacter injection but does nothing for structural violations (the library receives `undefined` for the `kind` discriminator and produces undefined runtime behaviour per `finding-validation.ts:92-93`).
- **The `5cc0` citation refers to `schemas-bundled.ts` exports**, not to artefacts in that run (which predate E8 and use `sprint-N-review.json`).
- **The same write-time gap probably exists for `evaluator-evidence-bundle-v1`** — verify before extending the fix.
