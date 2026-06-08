/**
 * Bridge between the config-server's F2 error model and trace event bodies.
 *
 * The emitter's `emit*` methods supply the envelope (sequence, type, timestamp,
 * runId); this module's job is to build the *body* portion of trust and
 * validation-abort events from upstream data — a resolved trust prompt, or a
 * config-validation error. The `*Body` types are precisely the event minus its
 * envelope, so a body produced here drops straight into the matching emit call.
 *
 * For validation aborts the key concern is faithfully but safely capturing the
 * originating error: {@link extractF2Payload} copies the error's structured
 * fields while dropping the noisy/non-portable `name` and `stack`.
 */

import { createError, type ConfigServerError, type ErrorCode } from '../config-server/errors.js';
import type {
  TrustEventEvent,
  ValidationAbortEvent,
  SafetyHaltEvent,
  PreflightAbortEvent,
} from './events.js';

/** A {@link TrustEventEvent} without its envelope fields — the part this module builds. */
export type TrustEventBody = Omit<
  TrustEventEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

/** A {@link ValidationAbortEvent} without its envelope fields. */
export type ValidationAbortBody = Omit<
  ValidationAbortEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

/** A {@link SafetyHaltEvent} without its envelope fields — what a builder here produces. */
export type SafetyHaltBody = Omit<
  SafetyHaltEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

/** A {@link PreflightAbortEvent} without its envelope fields — what {@link buildPreflightAbortBody} produces. */
export type PreflightAbortBody = Omit<
  PreflightAbortEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

/** The preflight-stage discriminant, re-derived from the event type. */
export type PreflightStage = PreflightAbortEvent['preflightStage'];

/**
 * The structured error shape {@link buildPreflightAbortBody} consumes.
 *
 * @property code the diagnostic envelope's `code` field — for the H3
 *   confine-hook preflight this is always the literal
 *   `'StaleProjectConfinementHook'`. Surfaced verbatim on the event body
 *   under `errorCode`.
 * @property subReason the per-branch discriminator the orchestrator emits
 *   (`'noGanRunDirAwareness'` or `'projectHookMisconfigured'`). Surfaced
 *   verbatim under `errorSubReason`.
 * @property message the human-readable remediation prose. Surfaced verbatim
 *   under `errorMessage`. The same string the operator sees in the
 *   diagnostic envelope; the trace event re-records it so a log reader does
 *   not have to cross-reference the stderr surface to recover the
 *   remediation text.
 */
export interface PreflightAbortError {
  code: string;
  subReason: string;
  message: string;
}

/**
 * The outcome of a trust prompt, as produced upstream.
 *
 * @property promptVariant which prompt was shown (introduction vs re-prompt).
 * @property userChoice the user's response.
 * @property contentHash the config content hash the prompt concerned.
 */
export interface TrustResolution {

  promptVariant: 'subsequentChange' | 'initialIntroduction';

  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';

  contentHash: string;
}

/**
 * Project a {@link TrustResolution} into a trust-event body ready to emit.
 * Pure mapping; no side effects, never throws.
 */
export function buildTrustEventBody(resolution: TrustResolution): TrustEventBody {
  return {
    promptVariant: resolution.promptVariant,
    userChoice: resolution.userChoice,
    contentHash: resolution.contentHash,
  };
}

/** The validation stage discriminant, re-derived from the event type. */
export type ValidationStage = ValidationAbortEvent['validationStage'];

/**
 * Structural shape of an F2-style config error. The index signature allows
 * arbitrary extra structured fields, which {@link extractF2Payload} preserves.
 *
 * @property code the error code.
 * @property message human-readable message.
 * @property file / field / line optional source-location hints.
 */
export interface F2ErrorLike {
  code: string;
  message: string;
  file?: string;
  field?: string;
  line?: number;
  [extra: string]: unknown;
}

// Error properties that must NOT enter a trace payload: `name` is redundant
// with `code`, and `stack` is environment-specific noise that would make the
// trace non-deterministic and leak local paths.
const NON_F2_KEYS: ReadonlySet<string> = new Set(['name', 'stack']);

// Extract the portable structured payload from an F2 error. Prefer the error's
// own toJSON() projection when it provides one (so a ConfigServerError controls
// its serialised form); otherwise read its own enumerable keys. Either way,
// drop the NON_F2_KEYS and any undefined value so the payload stays minimal
// and deterministic.
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
 * Build a validation-abort body from an already-constructed F2-like error.
 *
 * @param stage which validation layer rejected the config.
 * @param error the originating error; its `code` becomes `errorCode` and its
 *   portable fields become `errorPayload` (sans `name`/`stack`, see
 *   {@link extractF2Payload}).
 * @returns the body, ready to pass to the emitter. Never throws.
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
 * Convenience wrapper that constructs the error from a code + details and then
 * builds its abort body — for call sites that have a code in hand rather than a
 * thrown error.
 *
 * @param stage which validation layer rejected the config.
 * @param code the framework error code to construct.
 * @param details optional error details forwarded to {@link createError};
 *   defaults to `{}`.
 * @returns the validation-abort body. Never throws (constructs, does not raise).
 */
export function buildValidationAbortFromCode(
  stage: ValidationStage,
  code: ErrorCode,
  details: Parameters<typeof createError>[1] = {},
): ValidationAbortBody {
  const error: ConfigServerError = createError(code, details);
  return buildValidationAbortBody(stage, error);
}

/**
 * The loop-detection halt details a {@link buildLoopDetectedBody} call maps into
 * a `safetyHalt` event body. These are the `LoopDetected` halt-contract
 * fields minus `role`, which becomes a top-level event field rather than part of
 * the inlined payload.
 *
 * @property reason the camelCase discriminator (`roleCeilingExceeded` for the
 *   per-role ceiling halt).
 * @property role the kebab-case role id that triggered the halt.
 * @property attempts how many attempts had been made.
 * @property ceiling the configured ceiling that was hit.
 * @property evidence the discriminator-specific evidence value (an array for
 *   `roleCeilingExceeded`).
 */
export interface LoopDetectionHalt {
  reason: string;
  role: string;
  attempts: number;
  ceiling: number;
  evidence: unknown;
}

/**
 * Project loop-detection halt details into a `safetyHalt` event body with
 * `safetyClass = "loopDetected"`.
 *
 * Mirrors {@link buildTrustEventBody} / {@link buildValidationAbortBody}: a pure
 * mapping, no I/O, never throws. The triggering `role` becomes the event's
 * top-level `role` field (where every event class carries the responsible role),
 * while the loop-specific `reason` / `attempts` / `ceiling` / `evidence` are
 * inlined into the small structured `payload` — consistent with the rest of the
 * `LoopDetected` shape, so a trace reader recovers the halt detail without a
 * separate payload file.
 *
 * @param halt the {@link LoopDetectionHalt} detail to project.
 * @returns the {@link SafetyHaltBody}, ready to pass to the emitter. Never throws.
 */
export function buildLoopDetectedBody(halt: LoopDetectionHalt): SafetyHaltBody {
  return {
    safetyClass: 'loopDetected',
    role: halt.role,
    payload: {
      reason: halt.reason,
      attempts: halt.attempts,
      ceiling: halt.ceiling,
      evidence: halt.evidence,
    },
  };
}

/**
 * Project a preflight-abort error into a `preflightAbort` event body ready
 * for {@link emitTraceEvent}.
 *
 * Mirrors {@link buildValidationAbortBody}: a pure mapping, no I/O, never
 * throws. The body fields are limited to the four documented strings — the
 * stage discriminator, the structured-error code / subReason / message, and
 * the project-tier hook path — so operator state cannot leak into the
 * telemetry surface. Specifically, the function does NOT capture probe env,
 * stdin envelope, or hook contents; those are deliberately out of scope.
 *
 * @param stage the preflight discriminator (currently only
 *   `'confineHook'`). Surfaced verbatim under `preflightStage`.
 * @param error the structured diagnostic envelope the orchestrator already
 *   emitted to stderr. See {@link PreflightAbortError}.
 * @param hookPath the absolute path to the project-tier hook file that
 *   triggered the halt. Surfaced verbatim under `projectTierHookPath`.
 * @returns the body, ready to pass to the emitter. Never throws.
 */
export function buildPreflightAbortBody(
  stage: PreflightStage,
  error: PreflightAbortError,
  hookPath: string,
): PreflightAbortBody {
  return {
    preflightStage: stage,
    errorCode: error.code,
    errorSubReason: error.subReason,
    errorMessage: error.message,
    projectTierHookPath: hookPath,
  };
}
