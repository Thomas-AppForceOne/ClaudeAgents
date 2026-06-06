/**
 * terminalReasonToDisposition coverage suite — exercises every one of the ten
 * rows in O3's mapping table. The table is the spec's source of truth; a
 * regression here surfaces as a wrong disposition embedded in outcome.json,
 * which is what makes the table load-bearing.
 *
 * The suite is intentionally row-by-row (one `it` per terminalReason) rather
 * than a single parametric table, so a row regression names which code
 * broke its mapping without a reader having to decode an index.
 */

import { describe, expect, it } from 'vitest';

import { terminalReasonToDisposition } from '../../src/telemetry/mapping.js';

describe('terminalReasonToDisposition — verbatim ten-row O3 mapping table', () => {
  it('complete -> success', () => {
    expect(terminalReasonToDisposition('complete')).toBe('success');
  });

  it('failed-evaluation-rejected -> rejected', () => {
    expect(terminalReasonToDisposition('failed-evaluation-rejected')).toBe('rejected');
  });

  it('aborted-contract-failed -> rejected', () => {
    // Pre-generation refusal — shares the post-generation gate's rejected
    // bucket. Naming mismatch (aborted-* prefix, rejected disposition) is
    // deliberate and pinned by the spec.
    expect(terminalReasonToDisposition('aborted-contract-failed')).toBe('rejected');
  });

  it('failed-max-attempts -> halted', () => {
    expect(terminalReasonToDisposition('failed-max-attempts')).toBe('halted');
  });

  it('failed-budget -> halted', () => {
    expect(terminalReasonToDisposition('failed-budget')).toBe('halted');
  });

  it('failed-loop-detected -> halted', () => {
    expect(terminalReasonToDisposition('failed-loop-detected')).toBe('halted');
  });

  it('aborted-by-user -> aborted', () => {
    // The only row that maps to the aborted disposition — user-initiated
    // only, by O3's semantic definition of the bucket.
    expect(terminalReasonToDisposition('aborted-by-user')).toBe('aborted');
  });

  it('failed-clarifier-error -> errored', () => {
    expect(terminalReasonToDisposition('failed-clarifier-error')).toBe('errored');
  });

  it('aborted-planner-error -> errored', () => {
    expect(terminalReasonToDisposition('aborted-planner-error')).toBe('errored');
  });

  it('aborted-validation-failed -> errored', () => {
    // Taxonomy-only row. Per O2 this code is recorded when validateAll()
    // halts before the run dir exists, so the code cannot actually reach
    // outcome.json under the normal flow — but the mapping must still be
    // exhaustive over the ten O2 codes, and the function's never-typed
    // default arm enforces that.
    expect(terminalReasonToDisposition('aborted-validation-failed')).toBe('errored');
  });
});
