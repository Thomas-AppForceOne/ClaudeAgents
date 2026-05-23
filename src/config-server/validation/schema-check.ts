

import AjvImport, { type ErrorObject, type ValidateFunction } from 'ajv';

import {
  stackV1,
  overlayV1,
  runTraceV1,
  runTraceIndexV1,
  evaluatorEvidenceBundleV1,
} from '../schemas-bundled.js';

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

export interface Issue {
  code: string;
  path?: string;
  field?: string;
  message: string;
  severity?: 'error' | 'warning';
}

let stackValidator: ValidateFunction | null = null;
let overlayValidator: ValidateFunction | null = null;

function getStackValidator(): ValidateFunction {
  if (stackValidator !== null) return stackValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(stackV1);
  stackValidator = compiled;
  return compiled;
}

function getOverlayValidator(): ValidateFunction {
  if (overlayValidator !== null) return overlayValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(overlayV1);
  overlayValidator = compiled;
  return compiled;
}

let runTraceValidator: ValidateFunction | null = null;
let runTraceIndexValidator: ValidateFunction | null = null;
let evaluatorEvidenceBundleValidator: ValidateFunction | null = null;

export function getRunTraceValidator(): ValidateFunction {
  if (runTraceValidator !== null) return runTraceValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(runTraceV1);
  runTraceValidator = compiled;
  return compiled;
}

export function getRunTraceIndexValidator(): ValidateFunction {
  if (runTraceIndexValidator !== null) return runTraceIndexValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(runTraceIndexV1);
  runTraceIndexValidator = compiled;
  return compiled;
}

export function getEvaluatorEvidenceBundleValidator(): ValidateFunction {
  if (evaluatorEvidenceBundleValidator !== null) return evaluatorEvidenceBundleValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(evaluatorEvidenceBundleV1);
  evaluatorEvidenceBundleValidator = compiled;
  return compiled;
}

export function validateStackBodyAgainstSchema(
  filePath: string,
  data: unknown,
  issues: Issue[],
): void {
  if (!isObject(data)) {
    issues.push({
      code: 'SchemaMismatch',
      path: filePath,
      message: `Stack file '${filePath}' body must be a YAML mapping (object). Update the YAML body to start with key/value pairs.`,
      severity: 'error',
    });
    return;
  }

  if (!checkSchemaVersionExactMatch(filePath, data, 'Stack', issues)) return;

  const validator = getStackValidator();
  const stripped = stripFrontmatterFields(data);
  const ok = validator(stripped);
  if (ok) return;
  for (const err of validator.errors ?? []) {
    issues.push(ajvErrorToIssue(filePath, err, 'stack'));
  }
}

export function validateOverlayBodyAgainstSchema(
  filePath: string,
  data: unknown,
  issues: Issue[],
): void {
  if (data === null || data === undefined) return;
  if (!isObject(data)) {
    issues.push({
      code: 'SchemaMismatch',
      path: filePath,
      message: `Overlay file '${filePath}' body must be a YAML mapping (object). Update the YAML body to start with key/value pairs.`,
      severity: 'error',
    });
    return;
  }

  if (!checkSchemaVersionExactMatch(filePath, data, 'Overlay', issues)) return;

  const validator = getOverlayValidator();
  const stripped = stripFrontmatterFields(data);
  const ok = validator(stripped);
  if (ok) return;
  for (const err of validator.errors ?? []) {
    issues.push(ajvErrorToIssue(filePath, err, 'overlay'));
  }
}

function checkSchemaVersionExactMatch(
  filePath: string,
  data: Record<string, unknown>,
  subject: 'Stack' | 'Overlay',
  issues: Issue[],
): boolean {
  const schemaVersion = data['schemaVersion'];
  if (schemaVersion === 1) return true;
  issues.push({
    code: 'SchemaMismatch',
    path: filePath,
    field: '/schemaVersion',
    message:
      schemaVersion === undefined
        ? `${subject} file '${filePath}' is missing 'schemaVersion'. Add 'schemaVersion: 1' to the YAML body so the framework knows which schema to apply.`
        : `${subject} file '${filePath}' declares schemaVersion=${JSON.stringify(
            schemaVersion,
          )} but the framework only supports schemaVersion=1. Update the file to 'schemaVersion: 1'.`,
    severity: 'error',
  });
  return false;
}

function stripFrontmatterFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (k === 'name' || k === 'description' || k === 'schemaVersion' || k === 'pairsWith') continue;
    out[k] = data[k];
  }
  return out;
}

function ajvErrorToIssue(filePath: string, err: ErrorObject, kind: 'stack' | 'overlay'): Issue {
  const field = err.instancePath || undefined;
  const baseMessage = ajvMessage(err, kind);
  const remediation = ajvRemediation(err, kind);
  const message = remediation ? `${baseMessage} ${remediation}` : baseMessage;
  return {
    code: 'SchemaMismatch',
    path: filePath,
    field,
    message,
    severity: 'error',
  };
}

function ajvMessage(err: ErrorObject, kind: 'stack' | 'overlay'): string {
  const where = err.instancePath || '<root>';
  const subject = kind === 'stack' ? 'Stack file' : 'Overlay file';
  switch (err.keyword) {
    case 'required': {
      const params = err.params as { missingProperty?: string };
      const missing = params.missingProperty ?? 'unknown';
      return `${subject} field at ${where} is missing required property '${missing}'.`;
    }
    case 'additionalProperties': {
      const params = err.params as { additionalProperty?: string };
      const extra = params.additionalProperty ?? 'unknown';
      return `${subject} field at ${where} declares unknown property '${extra}'.`;
    }
    case 'type': {
      const params = err.params as { type?: string | string[] };
      const expected = Array.isArray(params.type) ? params.type.join('|') : params.type;
      return `${subject} field at ${where} has the wrong type; expected ${expected ?? 'a different type'}.`;
    }
    case 'enum': {
      const params = err.params as { allowedValues?: unknown[] };
      const allowed = (params.allowedValues ?? []).map((v) => JSON.stringify(v)).join(', ');
      return `${subject} field at ${where} is not one of the allowed values (${allowed || 'enum'}).`;
    }
    case 'const': {
      const params = err.params as { allowedValue?: unknown };
      return `${subject} field at ${where} must equal ${JSON.stringify(params.allowedValue)}.`;
    }
    case 'minLength':
    case 'minItems': {
      return `${subject} field at ${where} is too short. ${err.message ?? 'See the schema for length requirements.'}`;
    }
    case 'pattern': {
      return `${subject} field at ${where} does not match the required pattern. ${err.message ?? ''}`.trim();
    }
    case 'oneOf': {
      return `${subject} field at ${where} does not match any of the permitted shapes. Check the field against the documented forms.`;
    }
    default: {
      const tail = err.message ? `: ${err.message}` : '';
      return `${subject} field at ${where} failed validation${tail}.`;
    }
  }
}

function ajvRemediation(err: ErrorObject, kind: 'stack' | 'overlay'): string {
  const where = err.instancePath || '<root>';
  const subject = kind === 'stack' ? 'stack' : 'overlay';
  switch (err.keyword) {
    case 'required': {
      const params = err.params as { missingProperty?: string };
      return params.missingProperty
        ? `Add '${params.missingProperty}' to the ${subject} file's YAML body.`
        : `Add the missing property to the ${subject} file's YAML body.`;
    }
    case 'additionalProperties': {
      const params = err.params as { additionalProperty?: string };
      return params.additionalProperty
        ? `Remove '${params.additionalProperty}' from the ${subject} file's YAML body or move it under a documented field.`
        : `Remove the unknown property from the ${subject} file's YAML body.`;
    }
    case 'type':
      return `Update the value at ${where} so its type matches the schema.`;
    default:
      return '';
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
