/**
 * Schema validation against the bundled JSON Schemas, with Ajv's terse errors
 * translated into the project's user-facing {@link Issue} vocabulary.
 *
 * Two shared conventions hold throughout:
 * - Validators are compiled once and memoised; compilation is non-trivial and
 *   the schemas are immutable for the process lifetime.
 * - Validation never throws on a *data* problem. Every fault is appended to a
 *   caller-provided `issues` array (so several files can accumulate into one
 *   list); a clean document leaves the array untouched.
 *
 * Ajv is configured `strict: true` (reject schema misuse), `allErrors: true`
 * (report every violation, not just the first, so the user fixes them in one
 * pass), and `useDefaults: false` (validation must observe, never mutate, the
 * input).
 */

import AjvImport, { type ErrorObject, type ValidateFunction } from 'ajv';

import {
  stackV1,
  overlayV1,
  runTraceV1,
  runTraceIndexV1,
  evaluatorEvidenceBundleV1,
  progressV1,
} from '../schemas-bundled.js';

// Ajv ships as a CJS module whose constructor may live on `.default` under an
// ESM interop shim or directly on the namespace; normalise both forms to one
// callable constructor so `new Ajv(...)` works regardless of how it loaded.
type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv: AjvCtor =
  ((AjvImport as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport as unknown as AjvCtor);

/**
 * A single validation finding in the project's vocabulary.
 *
 * @property code stable machine code (e.g. `'SchemaMismatch'`,
 *   `'MalformedInput'`) callers branch on.
 * @property path the file the issue concerns, when known.
 * @property field the in-document location (a JSON-pointer fragment).
 * @property message human-facing description, often with a remediation tail.
 * @property severity `'error'` (blocks) or `'warning'`; absent ⇒ treat as error.
 */
export interface Issue {
  code: string;
  path?: string;
  field?: string;
  message: string;
  severity?: 'error' | 'warning';
}

// Memoised validators for the two interactively-edited document kinds.
let stackValidator: ValidateFunction | null = null;
let overlayValidator: ValidateFunction | null = null;

// Compile-once accessor for the stack-body validator (see module header for
// the Ajv option rationale).
function getStackValidator(): ValidateFunction {
  if (stackValidator !== null) return stackValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(stackV1);
  stackValidator = compiled;
  return compiled;
}

// Compile-once accessor for the overlay-body validator.
function getOverlayValidator(): ValidateFunction {
  if (overlayValidator !== null) return overlayValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(overlayV1);
  overlayValidator = compiled;
  return compiled;
}

// Memoised validators for the run-trace family of artefacts. Exported
// accessors (below) so other modules validate these without re-compiling.
let runTraceValidator: ValidateFunction | null = null;
let runTraceIndexValidator: ValidateFunction | null = null;
let evaluatorEvidenceBundleValidator: ValidateFunction | null = null;

/**
 * Compile-once Ajv validator for a single run-trace record.
 * @returns the memoised `ValidateFunction` (call it with the data to validate;
 *   inspect its `.errors` on a `false` result).
 */
export function getRunTraceValidator(): ValidateFunction {
  if (runTraceValidator !== null) return runTraceValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(runTraceV1);
  runTraceValidator = compiled;
  return compiled;
}

/**
 * Compile-once Ajv validator for the run-trace index.
 * @returns the memoised `ValidateFunction`.
 */
export function getRunTraceIndexValidator(): ValidateFunction {
  if (runTraceIndexValidator !== null) return runTraceIndexValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(runTraceIndexV1);
  runTraceIndexValidator = compiled;
  return compiled;
}

/**
 * Compile-once Ajv validator for the evaluator evidence bundle.
 * @returns the memoised `ValidateFunction`.
 */
export function getEvaluatorEvidenceBundleValidator(): ValidateFunction {
  if (evaluatorEvidenceBundleValidator !== null) return evaluatorEvidenceBundleValidator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(evaluatorEvidenceBundleV1);
  evaluatorEvidenceBundleValidator = compiled;
  return compiled;
}

// Memoised validator for the strict `progress-v1` schema. The compile is
// non-trivial (17 top-level required fields plus an allOf cross-field
// invariant), so we cache it.
let progressV1Validator: ValidateFunction | null = null;

/**
 * Compile-once Ajv validator for the `progress-v1` schema.
 * @returns the memoised `ValidateFunction` (call it with the data to validate;
 *   inspect its `.errors` on a `false` result).
 */
export function getProgressV1Validator(): ValidateFunction {
  if (progressV1Validator !== null) return progressV1Validator;
  const ajv = new Ajv({ strict: true, allErrors: true, useDefaults: false });
  const compiled = ajv.compile(progressV1);
  progressV1Validator = compiled;
  return compiled;
}

/**
 * Result of {@link validateProgress}: a pure pair of `{ valid, errors }`.
 *
 * @property valid `true` if the document conforms to `progress-v1`, `false`
 *   otherwise.
 * @property errors Ajv error objects when invalid; empty array when valid.
 */
export interface ValidateProgressResult {
  valid: boolean;
  errors: ErrorObject[];
}

/**
 * Validate `value` against the strict `progress-v1` schema.
 *
 * Pure; never throws. Wraps the memoised Ajv validator
 * ({@link getProgressV1Validator}) and normalises its `errors`/`null` output
 * into a consistent `{ valid, errors }` shape. The writer-side wiring in
 * `writeProgressFields` and `recordWorkspace` consumes this and chooses to
 * throw on `valid: false` so an invalid shape is caught at write-time rather
 * than discovered when a later read goes through the validator.
 *
 * @param value the parsed `progress.json` document to check.
 * @returns a {@link ValidateProgressResult}.
 */
export function validateProgress(value: unknown): ValidateProgressResult {
  const validator = getProgressV1Validator();
  const ok = validator(value);
  return {
    valid: ok === true,
    errors: ok === true ? [] : (validator.errors ?? []).slice(),
  };
}

/**
 * Validate a stack file's parsed YAML body against the v1 stack schema.
 *
 * @param filePath absolute path of the stack file, attached to every issue.
 * @param data the parsed body (any type; a non-object is itself an error).
 * @param issues accumulator; appended to on failure, untouched on success.
 *
 * Checks run in order and short-circuit: (1) the body must be a mapping; (2)
 * `schemaVersion` must be exactly `1`; (3) the rest is validated by Ajv. The
 * version gate runs *before* the Ajv pass so a wrong-version file yields one
 * clear `SchemaMismatch` rather than a flood of shape errors against the wrong
 * schema. Never throws — reports only via `issues`.
 */
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

  // Gate on version before invoking Ajv: validating against the wrong schema
  // would produce confusing, irrelevant errors.
  if (!checkSchemaVersionExactMatch(filePath, data, 'Stack', issues)) return;

  const validator = getStackValidator();
  const stripped = stripFrontmatterFields(data);
  const ok = validator(stripped);
  if (ok) return;
  for (const err of validator.errors ?? []) {
    issues.push(ajvErrorToIssue(filePath, err, 'stack'));
  }
}

/**
 * Validate an overlay file's parsed YAML body against the v1 overlay schema.
 *
 * Mirrors {@link validateStackBodyAgainstSchema} with one difference: a
 * `null`/`undefined` body is accepted as a no-op (an overlay file may legally
 * have an empty body — it simply contributes nothing), whereas a stack file
 * must have a mapping.
 *
 * @param filePath absolute path of the overlay file, attached to every issue.
 * @param data the parsed body; `null`/`undefined` is a valid empty overlay.
 * @param issues accumulator; appended to on failure, untouched on success.
 *
 * Never throws — reports only via `issues`.
 */
export function validateOverlayBodyAgainstSchema(
  filePath: string,
  data: unknown,
  issues: Issue[],
): void {
  // An empty overlay body is legal: it contributes nothing to the cascade.
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

// Require an exact `schemaVersion: 1`. Returns true to let validation proceed;
// on any other value (including absent) pushes a SchemaMismatch with a tailored
// message (missing vs. wrong version) and returns false so the caller stops
// before the Ajv pass. The framework only ships v1, so an unknown version is a
// hard mismatch rather than a forward-compatible read.
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

// Drop the "frontmatter" keys (name/description/schemaVersion/pairsWith) before
// handing the body to Ajv. These are managed/validated separately and are not
// part of the body schema, so leaving them in would trip the schema's
// additionalProperties checks.
function stripFrontmatterFields(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (k === 'name' || k === 'description' || k === 'schemaVersion' || k === 'pairsWith') continue;
    out[k] = data[k];
  }
  return out;
}

// Translate one raw Ajv ErrorObject into the project's Issue shape: a
// human-readable base message (ajvMessage) optionally followed by a concrete
// fix instruction (ajvRemediation). `instancePath` becomes the issue `field`
// (empty string ⇒ the root, recorded as absent).
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

// Render a human-readable description of an Ajv error. Ajv's own `err.message`
// is terse and context-free; this rewrites the common keywords (required,
// additionalProperties, type, enum, ...) into messages that name the offending
// location and property, falling back to Ajv's text for uncommon keywords.
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

// Produce a concrete fix instruction for the keywords where one is actionable
// (required/additionalProperties/type); returns '' for keywords where the base
// message already says everything useful, so no remediation tail is appended.
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

// Local plain-object guard: true only for a non-null, non-array object (the
// shape of a parsed YAML mapping).
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
