# single-defect — fail-as-rejection acceptance-case fixture

This fixture exercises the **fail-as-rejection** terminal outcome: a sprint whose
diff satisfies its **initial** contract but hides an **out-of-contract** defect
that the independent reviewer catches, the contract-proposer renegotiates into a
new criterion, and the evaluator then scores below threshold.

## Files

- `manifest.json` — machine-readable expectation: defect class, severity,
  expected finding kind, expected gate behaviour, the reproduction command, and
  the expected step-by-step flow through the framework.
- `defect-source.ts` — the actual defective implementation. A small (≤ 40 line)
  TypeScript module exporting `validateEmail(input: string): boolean` that
  satisfies the literal initial contract ("return true for syntactically valid
  email strings") but uses a JavaScript regex with `^…$` anchors against
  attacker-controlled input.

## The planted defect

The validator uses `^[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}$` with the `i` flag
but **no `m` adjustment** — and JavaScript's `^` and `$` match
**line boundaries** by default. A string of the form

```
victim@host.tld
BCC: attacker@evil.example
```

(a valid-looking address followed by a `\n` and an injected SMTP / mail-header
line) is therefore **accepted** as a "valid email" — the second line is
unreachable by the anchored match, but the first line satisfies it.

The defect is **out-of-contract** for the initial sprint contract, which only
asks for "syntactically valid email strings". The independent reviewer, however,
recognises the newline-injection vector and surfaces a `blocker`-severity
finding with a runnable reproduction command.

## Expected gate behaviour: `fail-as-rejection`

The expected end-to-end flow is documented in `manifest.json` under
`expectedFlow`. In summary:

1. Generator commits a diff that satisfies its initial sprint contract.
2. `gan-reviewer-independent` reviews the committed diff and runs the
   reproduction command from `manifest.json`. The command exits non-zero (the
   validator wrongly accepts the injection payload), so the finding passes the
   reproduction-gate and is admitted as well-founded.
3. `gan-contract-proposer` runs a renegotiation round: it consumes the
   surviving findings and adds a finding-derived criterion of class `security`,
   e.g. "validateEmail rejects strings containing CR or LF anywhere in the
   input".
4. `gan-contract-reviewer` audits the new criterion (well-formed +
   well-founded) and accepts it; the contract is atomically re-locked at
   revision `r1`, with `progress.json.contractRevision = 1` and the prior
   canonical archived as `sprint-{N}-contract.r0.json`.
5. `gan-evaluator` scores the current committed diff against the revised
   contract. The newline-injection criterion scores below its threshold; the
   security criterion class sits in the strict band (≥ 9), so an
   incremental fix is required. The sprint terminates with the recoverable
   terminal reason `failed-evaluation-rejected` — distinct from
   `LoopDetected`'s genuine-non-convergence reasons.

## Why this fixture is a single-defect case

The calibrated multi-defect suite (`tests/fixtures/e8/planted-defects/`) is
the **discriminator-quality** benchmark — it measures how many of N planted
defects the independent reviewer catches. This fixture is the **acceptance
case** for the `fail-as-rejection` flow itself: one defect, end-to-end, with
the expected progression through every renegotiation step.
