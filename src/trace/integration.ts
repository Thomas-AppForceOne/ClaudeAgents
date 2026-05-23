

import { createError, type ConfigServerError, type ErrorCode } from '../config-server/errors.js';
import type { TrustEventEvent, ValidationAbortEvent } from './events.js';

export type TrustEventBody = Omit<
  TrustEventEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

export type ValidationAbortBody = Omit<
  ValidationAbortEvent,
  'sequenceNumber' | 'eventType' | 'timestamp' | 'runId'
>;

export interface TrustResolution {

  promptVariant: 'subsequentChange' | 'initialIntroduction';

  userChoice: 'view' | 'approve' | 'runWithoutProjectCommands' | 'cancel';

  contentHash: string;
}

export function buildTrustEventBody(resolution: TrustResolution): TrustEventBody {
  return {
    promptVariant: resolution.promptVariant,
    userChoice: resolution.userChoice,
    contentHash: resolution.contentHash,
  };
}

export type ValidationStage = ValidationAbortEvent['validationStage'];

export interface F2ErrorLike {
  code: string;
  message: string;
  file?: string;
  field?: string;
  line?: number;
  [extra: string]: unknown;
}

const NON_F2_KEYS: ReadonlySet<string> = new Set(['name', 'stack']);

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

export function buildValidationAbortFromCode(
  stage: ValidationStage,
  code: ErrorCode,
  details: Parameters<typeof createError>[1] = {},
): ValidationAbortBody {
  const error: ConfigServerError = createError(code, details);
  return buildValidationAbortBody(stage, error);
}
