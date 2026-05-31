/**
 * Cross-consistency test for the three-place wiring of every known trace
 * event class.
 *
 * Why this test exists: a trace event class must be wired in THREE places
 * or the shipped scanner drops it as a forward-compatible unknown:
 *  (1) `schemas/run-trace-v1.json` — a `definitions/<name>` entry referenced
 *      by the top-level `oneOf` discriminated union, so the validator
 *      recognises the event.
 *  (2) `src/trace/events.ts` — a TS-union member with `eventType: '<name>'`,
 *      so consumers can narrow `TraceEvent` on the discriminant.
 *  (3) `src/trace/events.ts` — the runtime `KNOWN_EVENT_TYPES` set, which
 *      the scanner consults to tell a forward-compatible unknown class
 *      (skipped with a warning) apart from a known class.
 *
 * A class added to fewer than all three places silently breaks: a
 * schema-only addition validates but the scanner skips it; a union-only
 * addition compiles but the validator rejects it; a `KNOWN_EVENT_TYPES`-only
 * addition is accepted by the scanner but has no schema or type.
 *
 * The assertion strategy is to enumerate `KNOWN_EVENT_TYPES`, then for each
 * entry confirm (a) the schema's oneOf has a matching event class and (b)
 * the compile-time TS union has a matching discriminant value, and to
 * separately confirm the reverse direction (every schema oneOf entry has a
 * matching `KNOWN_EVENT_TYPES` member). The TS-side check is performed via
 * the standard `T extends {type: infer K} ? K : never` discriminant-extract
 * pattern so the union's literal values are statically materialised before
 * the runtime assertion runs.
 *
 * The test must explicitly include `'independentReview'` in the verified
 * set — both as an audit trail and as a regression guard that surfaces a
 * future drop of the class as a test failure.
 */

import { describe, expect, it } from 'vitest';

import { KNOWN_EVENT_TYPES, type TraceEvent } from '../../src/trace/events.js';
import { runTraceV1 } from '../../src/config-server/schemas-bundled.js';
import type { IndependentReviewEvent } from '../../src/trace/events.js';

// Compile-time extraction of the discriminant values present on the TraceEvent
// union. The pattern `T extends {eventType: infer K} ? K : never` distributes
// over the union, leaving the set of literal discriminant values as a single
// union type. The runtime mirror is then enumerable through a typed Set; a
// missing union member surfaces as a build error before the test runs.
type TraceEventDiscriminant = TraceEvent extends { eventType: infer K } ? K : never;

// A compile-time check that `independentReview` is one of the discriminants.
// If the union forgets the new class, this constant fails to type-check and
// the test file does not build — catching the drift at compile time.
const _independentReviewDiscriminantCheck: 'independentReview' extends TraceEventDiscriminant
  ? true
  : false = true;
void _independentReviewDiscriminantCheck;

// A compile-time check that the new event interface narrows correctly on the
// discriminant. The type system rejects this assignment if the event's
// eventType is not the literal 'independentReview' the schema and runtime set
// use.
const _independentReviewNarrowingCheck: IndependentReviewEvent['eventType'] =
  'independentReview';
void _independentReviewNarrowingCheck;

// Materialise the union's literals at runtime by listing them explicitly.
// Adding a class without updating this list — and KNOWN_EVENT_TYPES, and the
// schema's oneOf — fails the consistency check below. Listing them by hand
// is deliberate: it is the human-readable inventory the test guards.
const TS_UNION_DISCRIMINANTS = new Set<TraceEventDiscriminant>([
  'orchestratorMilestone',
  'agentAttempt',
  'llmCall',
  'toolCall',
  'safetyHalt',
  'trustEvent',
  'validationAbort',
  'clarifierFinding',
  'clarifierUserAction',
  'independentReview',
]);

function schemaEventClassNames(): Set<string> {
  // Reach into the bundled schema: find the allOf member that carries the
  // oneOf, then reduce the $refs to bare definition names. Mirrors the
  // existing run-trace schema test's traversal so the two stay in sync.
  const allOf = (runTraceV1 as { allOf: Array<Record<string, unknown>> }).allOf;
  const unionEntry = allOf.find((e) => Array.isArray(e.oneOf));
  if (!unionEntry) {
    throw new Error('run-trace-v1 schema is missing the oneOf union');
  }
  const oneOf = unionEntry.oneOf as Array<{ $ref: string }>;
  return new Set(oneOf.map((b) => b.$ref.replace('#/definitions/', '')));
}

describe('three-place wiring — every KNOWN_EVENT_TYPES entry is wired in all three places', () => {
  const schemaNames = schemaEventClassNames();

  for (const eventType of KNOWN_EVENT_TYPES) {
    it(`'${eventType}' has a matching schema event class`, () => {
      expect(
        schemaNames.has(eventType),
        `KNOWN_EVENT_TYPES has '${eventType}' but the run-trace-v1 schema's oneOf does not.`,
      ).toBe(true);
    });

    it(`'${eventType}' has a matching TS-union discriminant`, () => {
      // The TS_UNION_DISCRIMINANTS set is the runtime mirror of the
      // compile-time-extracted union literals; an entry missing here means a
      // KNOWN_EVENT_TYPES value has no TS-union member, the exact drift the
      // shipped scanner would silently accept while consumers fail to narrow.
      expect(
        (TS_UNION_DISCRIMINANTS as Set<string>).has(eventType),
        `KNOWN_EVENT_TYPES has '${eventType}' but the TraceEvent union does not narrow on it.`,
      ).toBe(true);
    });
  }
});

describe('three-place wiring — reverse direction (schema and TS union have no orphan classes)', () => {
  const schemaNames = schemaEventClassNames();

  for (const name of schemaNames) {
    it(`schema class '${name}' is in KNOWN_EVENT_TYPES`, () => {
      expect(
        KNOWN_EVENT_TYPES.has(name),
        `Schema class '${name}' is not in KNOWN_EVENT_TYPES — the scanner would skip it as a forward-compatible unknown.`,
      ).toBe(true);
    });
  }

  for (const discriminant of TS_UNION_DISCRIMINANTS) {
    it(`TS-union discriminant '${discriminant}' is in KNOWN_EVENT_TYPES`, () => {
      expect(
        KNOWN_EVENT_TYPES.has(discriminant),
        `TS-union discriminant '${discriminant}' is not in KNOWN_EVENT_TYPES — the scanner would skip an event whose schema and union both know.`,
      ).toBe(true);
    });
  }
});

describe('three-place wiring — independentReview is explicitly verified', () => {
  // Per the sprint contract: the test MUST explicitly include
  // 'independentReview' in the verified set, as a regression guard against a
  // future drop. These assertions repeat the table-driven check above with
  // the literal name so a grep for 'independentReview' lands here.
  it("'independentReview' is in KNOWN_EVENT_TYPES", () => {
    expect(KNOWN_EVENT_TYPES.has('independentReview')).toBe(true);
  });

  it("'independentReview' is a schema event class", () => {
    expect(schemaEventClassNames().has('independentReview')).toBe(true);
  });

  it("'independentReview' is a TS-union discriminant", () => {
    expect((TS_UNION_DISCRIMINANTS as Set<string>).has('independentReview')).toBe(true);
  });

  it('KNOWN_EVENT_TYPES.size === 10 after sprint 5 (was 9 before)', () => {
    // Numerical guard against the same drop direction: if 'independentReview'
    // is silently removed from KNOWN_EVENT_TYPES, the size returns to 9 and
    // this test fails. The number is intentionally a literal so the
    // expectation is auditable from the test source alone.
    expect(KNOWN_EVENT_TYPES.size).toBe(10);
  });
});
