/**
 * The config-server's single error vocabulary.
 *
 * Every fault the server raises — whether thrown or folded into a returned
 * `Issue` — is a {@link ConfigServerError} carrying a stable {@link ErrorCode}.
 * Callers branch on `code` (never on message text, which is human-facing and
 * may change); the codes are the machine contract. Build errors with the
 * {@link createError} factory rather than `new ConfigServerError` directly so
 * the default message and `NotImplemented` special-casing are applied
 * consistently.
 *
 * Shared guarantee: a `ConfigServerError` is always JSON-serialisable via
 * {@link ConfigServerError.toJSON}, which is what crosses the MCP boundary —
 * the live `name`/`stack` are dropped and every other own field is preserved.
 */

/**
 * Closed set of machine-readable error codes. This union is the stable
 * contract callers switch on; messages are advisory. Adding a code is a
 * breaking change to that contract (and requires a matching default message in
 * {@link DEFAULT_MESSAGES}, which is keyed exhaustively by this type).
 */
export type ErrorCode =
  | 'SchemaMismatch'
  | 'InvalidYAML'
  | 'MissingFile'
  | 'UnknownStack'
  | 'UnknownSplicePoint'
  | 'InvariantViolation'
  | 'ValidationFailed'
  | 'UnknownApiVersion'
  | 'UntrustedOverlay'
  | 'TrustCacheCorrupt'
  | 'PathEscape'
  | 'NotImplemented'
  | 'MalformedInput'
  | 'CacheEnvConflict'
  | 'ModuleManifestInvalid'
  | 'ModuleCollision'
  | 'ModulePrerequisiteFailed'
  | 'PlatformNotSupported'
  | 'TimeoutError'
  | 'PortInUse'
  | 'PortNotDiscovered'
  | 'UnknownStateKey'
  | 'LoopDetected'
  | 'InvalidTimeoutValue';

/**
 * The fully-specified shape of an error: a `code` and `message` plus optional
 * location/remediation context. Extra arbitrary fields are permitted (the
 * index signature) so a call site can attach domain context without growing
 * this interface.
 *
 * @property code the machine-readable {@link ErrorCode}.
 * @property message human-facing description (advisory, not a contract).
 * @property file absolute path of the offending config file, when applicable.
 * @property path JSON/structural path within a document, when applicable.
 * @property field the specific field at fault (often a JSON-pointer fragment).
 * @property line 1-based source line, when a parser pinpointed the fault.
 * @property column 1-based source column, paired with `line`.
 * @property remediation a concrete fix instruction shown to the user.
 */
export interface ConfigServerErrorShape {
  code: ErrorCode;
  message: string;
  file?: string;
  path?: string;
  field?: string;
  line?: number;
  column?: number;
  remediation?: string;

  [extra: string]: unknown;
}

/**
 * Caller-supplied details for {@link createError}. Same fields as
 * {@link ConfigServerErrorShape} minus the mandatory `code` (passed
 * separately) and `message` (optional here — a default is filled in from
 * {@link DEFAULT_MESSAGES} when omitted).
 *
 * @property tool the tool name; used only to synthesise the default
 *   `NotImplemented` message, and otherwise carried through as extra context.
 */
export interface ErrorDetails {
  message?: string;
  file?: string;
  path?: string;
  field?: string;
  line?: number;
  column?: number;
  remediation?: string;
  tool?: string;
  [extra: string]: unknown;
}

/**
 * The error type thrown (and serialised) throughout the config-server. It is a
 * real `Error` subclass — so it interoperates with `instanceof`, `throw`, and
 * stack traces — that additionally carries the {@link ConfigServerErrorShape}
 * fields as own properties.
 *
 * Construct via {@link createError} rather than directly: the factory supplies
 * default messages and the `NotImplemented` message synthesis.
 */
export class ConfigServerError extends Error implements ConfigServerErrorShape {
  public readonly code: ErrorCode;
  public readonly file?: string;
  public readonly path?: string;
  public readonly field?: string;
  public readonly line?: number;
  public readonly column?: number;
  public readonly remediation?: string;

  [extra: string]: unknown;

  /**
   * @param shape the complete error shape; `shape.message` becomes the
   *   `Error` message. Known optional fields are copied only when present (so
   *   they read as absent, not `undefined`), and any remaining keys are copied
   *   verbatim onto the instance via the index signature.
   */
  constructor(shape: ConfigServerErrorShape) {
    super(shape.message);
    this.name = 'ConfigServerError';
    this.code = shape.code;
    if (shape.file !== undefined) this.file = shape.file;
    if (shape.path !== undefined) this.path = shape.path;
    if (shape.field !== undefined) this.field = shape.field;
    if (shape.line !== undefined) this.line = shape.line;
    if (shape.column !== undefined) this.column = shape.column;
    if (shape.remediation !== undefined) this.remediation = shape.remediation;
    // Copy through any caller-supplied extra context, skipping the keys
    // already assigned above so they are not duplicated.
    for (const k of Object.keys(shape)) {
      if (
        k !== 'code' &&
        k !== 'message' &&
        k !== 'file' &&
        k !== 'path' &&
        k !== 'field' &&
        k !== 'line' &&
        k !== 'column' &&
        k !== 'remediation'
      ) {
        this[k] = shape[k];
      }
    }
  }

  /**
   * Serialise to a plain {@link ConfigServerErrorShape} for transport across
   * the MCP boundary.
   *
   * `code` and `message` are emitted unconditionally (the `Error.message`
   * lives on the prototype, not as an own key, so it must be set explicitly).
   * The runtime-only `name` and `stack` are deliberately omitted, and any
   * own field whose value is `undefined` is dropped so the JSON stays minimal.
   */
  toJSON(): ConfigServerErrorShape {
    const out: ConfigServerErrorShape = {
      code: this.code,
      message: this.message,
    };
    for (const k of Object.keys(this)) {
      if (k === 'name' || k === 'stack') continue;
      const v = (this as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
}

// Fallback human-facing message per code, used when a call site does not
// supply one. Keyed by the full ErrorCode union, so adding a code is a
// compile error here until a default is written — keeping the two in lockstep.
const DEFAULT_MESSAGES: Record<ErrorCode, string> = {
  SchemaMismatch: 'Schema version mismatch.',
  InvalidYAML: 'Invalid YAML in configuration file.',
  MissingFile: 'Required configuration file is missing.',
  UnknownStack: 'Stack name is not recognised.',
  UnknownSplicePoint: 'Overlay splice point is not recognised.',
  InvariantViolation: 'Cross-file invariant violated.',
  ValidationFailed: 'Validation failed.',
  UnknownApiVersion: 'API version is not recognised.',
  UntrustedOverlay: 'Project overlay has not been approved by the user.',
  TrustCacheCorrupt: 'Trust cache file is unreadable or malformed.',
  PathEscape: 'Path attempts to escape the project root.',
  NotImplemented: 'This tool is not yet implemented in the current sprint.',
  MalformedInput: 'Tool received malformed input.',
  CacheEnvConflict: 'Two active stacks declare conflicting cacheEnv values for the same key.',
  ModuleManifestInvalid: 'Module manifest failed schema validation.',
  ModuleCollision: 'Two modules declare the same name; module names must be unique.',
  ModulePrerequisiteFailed: 'Module prerequisite check failed.',
  PlatformNotSupported: 'This operation is not supported on the current platform.',
  TimeoutError: 'Operation timed out before completion.',
  PortInUse: 'Requested port is already in use.',
  PortNotDiscovered: 'Could not discover a port for the requested container.',
  UnknownStateKey:
    'Module-state operation referenced a state key that is not declared in the module manifest.',
  // Loop/thrash safety halt. The default is intentionally generic; the real
  // user-facing prose (which names attempt counts, the trace directory, and the
  // recovery flow) is built by the safety module and passed as `details.message`
  // — this default only covers a LoopDetected raised without an explicit message.
  LoopDetected: 'The framework halted the sprint to avoid an unproductive loop.',
  // The clarifier draft-timeout value is out of range. The default names the
  // valid bound and points at the dedicated skip flag: a zero timeout is the
  // common "I want to bypass" mistake, and a separate flag already expresses
  // that intent, so the framework rejects a zero here rather than overloading
  // it. A call site attaches the offending field and the actual value as
  // `details.message`.
  InvalidTimeoutValue:
    'The clarifier draft-timeout value is out of range; it must be an integer between 10 and 600 seconds. To bypass clarification entirely, use the dedicated skip flag rather than a zero timeout.',
};

/**
 * Canonical factory for a {@link ConfigServerError}. Prefer this over the
 * constructor everywhere.
 *
 * @param code the {@link ErrorCode} to raise.
 * @param details optional context. `details.message`, when present, overrides
 *   the default; all other keys (`file`/`path`/`field`/`tool`/extras) are
 *   carried onto the error verbatim.
 * @returns a constructed (not thrown) `ConfigServerError`; the caller decides
 *   whether to `throw` it or fold it into an `Issue`.
 *
 * Message resolution: an explicit `details.message` wins; otherwise the
 * per-code {@link DEFAULT_MESSAGES} entry is used. As a special case, a
 * `NotImplemented` error with a `tool` and no explicit message gets a
 * tool-named message so the user sees which tool is unimplemented.
 */
export function createError(code: ErrorCode, details: ErrorDetails = {}): ConfigServerError {
  const { message: providedMessage, ...rest } = details;
  let message = providedMessage ?? DEFAULT_MESSAGES[code];
  if (code === 'NotImplemented' && rest.tool && !providedMessage) {
    message = `Tool '${String(rest.tool)}' is not yet implemented in the current sprint.`;
  }
  const shape: ConfigServerErrorShape = { code, message, ...rest };
  return new ConfigServerError(shape);
}
