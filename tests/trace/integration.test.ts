/**
 * T1 Sprint 3 — integration-event builders (F3.3, F3.4).
 *
 * Covers contract criteria:
 *  - validation_abort_builder_preserves_f2_payload_verbatim
 *  - trust_event_builder_maps_choices
 *
 * Each builder produces an event BODY; we envelope it (the way the emitter
 * would) and assert the enveloped event validates against run-trace-v1.json
 * via getRunTraceValidator.
 */
import { describe, expect, it } from 'vitest';

import {
  buildTrustEventBody,
  buildValidationAbortBody,
  buildValidationAbortFromCode,
} from '../../src/trace/integration.js';
import { createError } from '../../src/config-server/errors.js';
import { getRunTraceValidator } from '../../src/config-server/validation/schema-check.js';

const RUN_ID = '20260521T194720-6752';
const SHA = 'b'.repeat(64);

/** Envelope a class body the way TraceEmitter would, for schema validation. */
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

    // errorCode is the PascalCase F2 code, preserved exactly.
    expect(body.errorCode).toBe('PathEscape');
    // validationStage is the supplied stage.
    expect(body.validationStage).toBe('overlay');
    // errorPayload deep-equals the source F2 payload — every field present,
    // unchanged, none dropped, none renamed.
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
    // No file/field/line keys leaked in when the source had none.
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
