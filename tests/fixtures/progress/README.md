# progress-v1 fixtures

`progress-v1-e8-renegotiated.json` is the reconciliation-gate fixture: it
exercises the E8↔O2 seam by carrying `contractRevision > 0` and
`terminalReason: "failed-evaluation-rejected"`, and validates against
`schemas/progress-v1.json` under the strict `additionalProperties: false`
posture.

## Hand-crafted placeholder pending real capture

This fixture is currently a **hand-crafted shape**. The schema spec calls for
a fixture **captured from a real renegotiated dogfood run** — the orchestrator
emitting `progress.json` at the moment a run halts on the renegotiation cap
with unresolved blocker findings. Such a capture is the schema-reconciliation
merge gate's intended source of truth; a hand-crafted file proves the schema
accepts a plausible shape but not that it accepts the *actual* shape the
shipped writers produce.

## Deferred-capture handoff

Replacing this placeholder with a captured artefact is the release-gate
dogfood's responsibility:

1. Run `/gan` on a project rigged to fail evaluator review past the
   renegotiation cap.
2. Locate the resulting `progress.json` under the run's central-store
   directory.
3. Copy the file verbatim into this directory, overwriting the placeholder.
4. Re-run the schema test suite; the strict schema must continue to validate.

Until that replacement lands, the reconciliation merge gate is "satisfied by a
plausible shape" rather than "satisfied by a real capture". The deferred
handoff is recorded here visibly so downstream auditors can confirm the gap
was not silently substituted.
