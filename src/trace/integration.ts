/**
 * T1 Sprint 3 — integration-event builders (F3.3, F3.4).
 *
 * Two pure builders that construct a `trustEvent` and a `validationAbort`
 * event-class BODY (the class-specific fields, without the common envelope).
 * The orchestrator/skill runtime calls these at trust-prompt resolution and
 * on a `validateAll()` abort respectively, then stamps the envelope via the
 * `TraceEmitter` (the live wiring is documented in `skills/gan/SKILL.md`).
 * Here they are unit-testable: the body is constructed deterministically and,
 * once enveloped, validates against `schemas/run-trace-v1.json`.
 *
 * The load-bearing fidelity contract (F3.4): the F2 error payload is copied
 * into `errorPayload` VERBATIM — every field of `{code, message, file?,
 * field?, line?, ...}` preserved with no paraphrase, no key renaming, no
 * reformatting, and no dropped fields. The PascalCase `errorCode` (an F2 code
 * such as `UntrustedOverlay`, `PathEscape`) is kept distinct from the
 * camelCase trace discriminators by design.
 */

import { createError, type ConfigServerError, type ErrorCode } from '../config-server/errors.js';
import type {
  TrustEventEvent,
  ValidationAbortEvent,
} from './events.js';

/** The class-specific fields of a `trustEvent` (no common envelope). */
export type TrustEventBody = Omit<
  TrustEventEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

/** The class-specific fields of a `validationAbort` (no common envelope). */
export type ValidationAbortBody = Omit<
  ValidationAbortEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

/** A resolved F4 trust prompt: the variant shown and the user's choice. */
export interface TrustResolution {
  /** Which prompt variant was rendered. */
  promptVariant: 'subsequentChange' | 'initialIntroduction';
  /**
   * The user's choice. The four-way enum mirrors the trust-prompt
   * `[v]`/`[a]`/`[r]`/`[c]` option set; `approve` and
   * `runWithoutProjectCommands` are DISTINCT outcomes and must not collapse.
   */
  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';
  /** The content hash the prompt covered: bare lowercase 64-hex SHA-256. */
  contentHash: string;
}

/**
 * Build the body of a `trustEvent` from a resolved trust prompt. A pure copy
 * of the three class fields — `promptVariant`, `userChoice`, `contentHash` —
 * with no transformation, so the `[a]`/`approve` and
 * `[r]`/`runWithoutProjectCommands` distinction is preserved exactly as the
 * caller resolved it. Enveloped by the emitter, the result validates against
 * `run-trace-v1.json`.
 */
export function buildTrustEventBody(resolution: TrustResolution): TrustEventBody {
  return {
    promptVariant: resolution.promptVariant,
    userChoice: resolution.userChoice,
    contentHash: resolution.contentHash,
  };
}

/** The validation pipeline stage that aborted (F2 / `validateAll()`). */
export type ValidationStage = ValidationAbortEvent['validationStage'];

/**
 * The minimal F2 error shape the builder reads. A `ConfigServerError`
 * (the repo's `createError` product) satisfies this; so does any plain object
 * carrying at least an F2 `code`. The payload is preserved verbatim, so all
 * extra fields ride along untouched.
 */
export interface F2ErrorLike {
  code: string;
  message: string;
  file?: string;
  field?: string;
  line?: number;
  [extra: string]: unknown;
}

/**
 * The set of keys the F2 error model exposes on a serialised error but which
 * are runtime-only artefacts of the `Error` base class, not part of the F2
 * payload. They are excluded so `errorPayload` carries the F2 shape and not
 * the JS stack trace or class name.
 */
const NON_F2_KEYS: ReadonlySet<string> = new Set(['name', 'stack']);

/**
 * Extract the verbatim F2 payload from an F2-shaped error. Every own,
 * defined field other than the `Error`-base runtime artefacts (`name`,
 * `stack`) is copied across UNCHANGED — same keys, same values, nothing
 * paraphrased, reformatted, or dropped. A `ConfigServerError` exposes its F2
 * fields as own enumerable properties (and provides `toJSON()` to the same
 * effect), so this yields a deep-equal copy of the source payload.
 */
function extractF2Payload(error: F2ErrorLike): Record<string, unknown> {
  const maybeToJson = (error as { toJSON?: () => Record<string, unknown> }).toJSON;
  const source: Record<string, unknown> =
    typeof maybeToJson === 'function'
      ? maybeToJson.call(error)
      : (error as unknown as Record<string, unknown>);

  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (NON_F2_KEYS.has(key)) continue;
    const value = source[key];
    if (value === undefined) continue;
    payload[key] = value;
  }
  return payload;
}

/**
 * Build the body of a `validationAbort` event from an F2 issue/error.
 *
 *  - `validationStage` is the supplied pipeline stage.
 *  - `errorCode` is the F2 error's PascalCase code (preserved exactly; the
 *    distinction from the camelCase trace discriminators is intentional).
 *  - `errorPayload` is the F2 payload preserved VERBATIM — deep-equal to the
 *    source, with every present field (including optional `file`/`field`/
 *    `line`) carried through unchanged.
 *
 * Enveloped by the emitter, the result validates against `run-trace-v1.json`.
 */
export function buildValidationAbortBody(
  stage: ValidationStage,
  error: F2ErrorLike,
): ValidationAbortBody {
  return {
    validationStage: stage,
    errorCode: error.code,
    errorPayload: extractF2Payload(error),
  };
}

/**
 * Convenience for callers holding an F2 `code` + details rather than a
 * constructed error: build the `ConfigServerError` via the repo's
 * `createError` factory, then derive the `validationAbort` body from it. The
 * payload is still preserved verbatim from the factory's output.
 */
export function buildValidationAbortFromCode(
  stage: ValidationStage,
  code: ErrorCode,
  details: Parameters<typeof createError>[1] = {},
): ValidationAbortBody {
  const error: ConfigServerError = createError(code, details);
  return buildValidationAbortBody(stage, error);
}
