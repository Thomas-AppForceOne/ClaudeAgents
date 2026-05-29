/**
 * Trace integration-body builders suite — these helpers shape the two event
 * bodies the orchestrator wires in from outside the trace library (trust
 * prompts and validation aborts), so the suite guards faithful mapping into a
 * schema-valid envelope.
 *
 * trustEvent (buildTrustEventBody): each of the four userChoice outcomes maps
 * to its OWN enum value — the critical case is that `approve` and
 * `runWithoutProjectCommands` are NOT collapsed (they carry different trust
 * semantics). Both promptVariant values round-trip, and the helper's output,
 * wrapped in an envelope, validates against run-trace-v1; an out-of-enum
 * userChoice is rejected by the schema.
 *
 * validationAbort (buildValidationAbortBody / ...FromCode): the F2 error
 * payload is preserved VERBATIM (deep-equal), including optional file/field/
 * line/remediation context, while the Error base-class runtime artefacts
 * (name/stack) are dropped — a trace must record the structured error, not a
 * stack trace. It also accepts a plain F2-shaped object, not only a real
 * ConfigServerError, so callers needn't construct the class.
 *
 * envelope() supplies the shared header (sequence/eventType/timestamp/runId) so
 * each test can validate the builder output as a complete event.
 */

import { describe, expect, it } from 'vitest';

import {
  buildTrustEventBody,
  buildValidationAbortBody,
  buildValidationAbortFromCode,
} from '../../src/trace/integration.js';
import { aggregateSprintSummary } from '../../src/trace/progress.js';
import { createError } from '../../src/config-server/errors.js';
import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';

const RUN_ID = '20260521T194720-6752';
const SHA = 'b'.repeat(64);

function envelope(eventType: string, body: Record<string, unknown>): Record<string, unknown> {
  return {
    sequenceNumber: 7,
    eventType,
    timestamp: '2026-05-21T19:47:20.000Z',
    runId: RUN_ID,
    ...body,
  };
}

describe('trust_event_builder_maps_choices', () => {
  const choices = ['view', 'approve', 'runWithoutProjectCommands', 'cancel'] as const;
  const variants = ['subsequentChange', 'initialIntroduction'] as const;

  it('maps each of the four userChoice outcomes to its own enum value', () => {
    for (const userChoice of choices) {
      const body = buildTrustEventBody({
        promptVariant: 'subsequentChange',
        userChoice,
        contentHash: SHA,
      });
      expect(body.userChoice).toBe(userChoice);
    }
  });

  it('does NOT collapse approve vs runWithoutProjectCommands', () => {
    const approve = buildTrustEventBody({
      promptVariant: 'subsequentChange',
      userChoice: 'approve',
      contentHash: SHA,
    });
    const runWithout = buildTrustEventBody({
      promptVariant: 'subsequentChange',
      userChoice: 'runWithoutProjectCommands',
      contentHash: SHA,
    });
    expect(approve.userChoice).toBe('approve');
    expect(runWithout.userChoice).toBe('runWithoutProjectCommands');
    expect(approve.userChoice).not.toBe(runWithout.userChoice);
  });

  it('carries both promptVariant values and validates against the schema', () => {
    const validate = getRunTraceValidator();
    for (const promptVariant of variants) {
      for (const userChoice of choices) {
        const body = buildTrustEventBody({ promptVariant, userChoice, contentHash: SHA });
        expect(body.promptVariant).toBe(promptVariant);
        const event = envelope('trustEvent', { ...body });
        expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
      }
    }
  });

  it('the schema rejects an out-of-enum userChoice', () => {
    const validate = getRunTraceValidator();
    const event = envelope('trustEvent', {
      promptVariant: 'subsequentChange',
      userChoice: 'someUnknownChoice',
      contentHash: SHA,
    });
    expect(validate(event)).toBe(false);
  });
});

describe('validation_abort_builder_preserves_f2_payload_verbatim', () => {
  it('preserves the F2 payload verbatim (deep-equal) including optional file/field/line', () => {
    const error = createError('PathEscape', {
      message: 'The framework refused a path that escapes the project root.',
      file: '/repo/.claude/gan/project.md',
      field: '/commands/0',
      line: 12,
    });
    const sourcePayload = error.toJSON();

    const body = buildValidationAbortBody('overlay', error);

    expect(body.errorCode).toBe('PathEscape');

    expect(body.validationStage).toBe('overlay');

    expect(body.errorPayload).toEqual(sourcePayload);
    expect(body.errorPayload.code).toBe('PathEscape');
    expect(body.errorPayload.message).toBe(
      'The framework refused a path that escapes the project root.',
    );
    expect(body.errorPayload.file).toBe('/repo/.claude/gan/project.md');
    expect(body.errorPayload.field).toBe('/commands/0');
    expect(body.errorPayload.line).toBe(12);
  });

  it('preserves an UntrustedOverlay payload and validates against the schema', () => {
    const validate = getRunTraceValidator();
    const error = createError('UntrustedOverlay', {
      message: 'Project overlay has not been approved by the user.',
      file: '/repo/.claude/gan/project.md',
    });
    const body = buildValidationAbortBody('config', error);
    expect(body.errorCode).toBe('UntrustedOverlay');
    expect(body.errorPayload).toEqual(error.toJSON());

    const event = envelope('validationAbort', { ...body });
    expect(validate(event), JSON.stringify(validate.errors)).toBe(true);
  });

  it('preserves a payload with no optional fields (only code + message)', () => {
    const error = createError('ValidationFailed', { message: 'Validation failed.' });
    const body = buildValidationAbortBody('stack', error);
    expect(body.errorPayload).toEqual({ code: 'ValidationFailed', message: 'Validation failed.' });

    expect(Object.keys(body.errorPayload).sort()).toEqual(['code', 'message']);
  });

  it('preserves extra F2 context fields verbatim (no dropped fields)', () => {
    const error = createError('SchemaMismatch', {
      message: 'Schema version mismatch.',
      file: '/repo/stack.md',
      field: '/schemaVersion',
      remediation: 'Update the file to schemaVersion: 1.',
    });
    const body = buildValidationAbortBody('stack', error);
    expect(body.errorPayload).toEqual(error.toJSON());
    expect(body.errorPayload.remediation).toBe('Update the file to schemaVersion: 1.');
  });

  // A trace records the structured F2 error, not a runtime stack trace — so
  // the inherited Error.name/Error.stack must not leak into the payload.
  it('does not carry the Error base-class runtime artefacts (name/stack)', () => {
    const error = createError('PathEscape', { message: 'm' });
    const body = buildValidationAbortBody('overlay', error);
    expect(body.errorPayload.name).toBeUndefined();
    expect(body.errorPayload.stack).toBeUndefined();
  });

  it('buildValidationAbortFromCode constructs via createError and preserves the payload', () => {
    const body = buildValidationAbortFromCode('module', 'ModuleManifestInvalid', {
      message: 'Module manifest failed schema validation.',
      file: '/repo/modules/docker/manifest.json',
    });
    expect(body.errorCode).toBe('ModuleManifestInvalid');
    expect(body.errorPayload).toEqual(
      createError('ModuleManifestInvalid', {
        message: 'Module manifest failed schema validation.',
        file: '/repo/modules/docker/manifest.json',
      }).toJSON(),
    );
    const validate = getRunTraceValidator();
    expect(validate(envelope('validationAbort', { ...body }))).toBe(true);
  });

  it('accepts a plain F2-shaped object (not just a ConfigServerError)', () => {
    const plain = { code: 'CustomCode', message: 'something', file: '/x', line: 3 };
    const body = buildValidationAbortBody('config', plain);
    expect(body.errorCode).toBe('CustomCode');
    expect(body.errorPayload).toEqual(plain);
  });
});

/**
 * Sprint-2 additive: the `toolCalls` counter on aggregateSprintSummary +
 * SprintSummaryAggregate. The field is the lone new domain logic R7
 * introduces; the test pins the three property claims (a) the field
 * exists on the returned aggregate, (b) it equals the count of `toolCall`
 * events in the input, (c) it is 0 on a trace with no `toolCall` events.
 *
 * The extension uses the same `aggregateSprintSummary` import the rest of
 * the suite uses — no second counting loop is added; the criterion's
 * "single-implementation" claim is pinned by inspection of the source
 * file (one counting loop in src/trace/progress.ts).
 */
describe('toolCalls counter — additive on aggregateSprintSummary', () => {
  const baseEnv = {
    timestamp: '2026-05-22T17:00:00.000Z',
    runId: RUN_ID,
  };

  it('toolCalls field exists on the SprintSummaryAggregate', () => {
    const summary = aggregateSprintSummary([]);
    expect(summary).toHaveProperty('toolCalls');
    expect(summary.toolCalls).toBe(0);
  });

  it('toolCalls equals the count of toolCall events in the input', () => {
    const events = [
      {
        ...baseEnv,
        sequenceNumber: 0,
        eventType: 'toolCall',
        tool: 'someTool',
        role: 'gan-generator',
        argumentsRef: 'payloads/0-gan-generator-arguments.json',
        resultRef: 'payloads/0-gan-generator-result.json',
        disposition: 'completed',
        latencyMs: 5,
      },
      {
        ...baseEnv,
        sequenceNumber: 1,
        eventType: 'toolCall',
        tool: 'otherTool',
        role: 'gan-generator',
        argumentsRef: 'payloads/1-gan-generator-arguments.json',
        resultRef: 'payloads/1-gan-generator-result.json',
        disposition: 'completed',
        latencyMs: 10,
      },
      {
        ...baseEnv,
        sequenceNumber: 2,
        eventType: 'agentAttempt',
        role: 'gan-generator',
        attemptNumber: 1,
        inputDigest: 'a'.repeat(64),
        outputArtifactPath: 'attempt-0.md',
        disposition: 'completed',
      },
    ];
    // The events are stripped to the fields the aggregator reads; the
    // cast is safe because aggregateSprintSummary discriminates on
    // eventType and reads only documented fields.
    const summary = aggregateSprintSummary(
      events as unknown as Parameters<typeof aggregateSprintSummary>[0],
    );
    expect(summary.toolCalls).toBe(2);
    expect(summary.agents).toBe(1);
    expect(summary.calls).toBe(0);
  });

  it('toolCalls is 0 on a trace with no toolCall events', () => {
    const summary = aggregateSprintSummary([
      {
        ...baseEnv,
        sequenceNumber: 0,
        eventType: 'agentAttempt',
        role: 'gan-generator',
        attemptNumber: 1,
        inputDigest: 'a'.repeat(64),
        outputArtifactPath: 'attempt-0.md',
        disposition: 'completed',
      },
    ] as unknown as Parameters<typeof aggregateSprintSummary>[0]);
    expect(summary.toolCalls).toBe(0);
  });
});
