/**
 * Error factory for the @claudeagents/config-server.
 *
 * R1-locked rule: every error code from F2's enum is constructed via this
 * module. No inline `throw new Error(...)` anywhere else in the codebase.
 *
 * The shape mirrors F2's "Error model" section: `{ code, message, file?,
 * field?, line?, column?, remediation? }`. The factory returns plain objects
 * that can be `throw`n directly (they are real `Error` instances) and also
 * serialised to JSON for MCP responses without further massaging.
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
  | 'UnknownStateKey';

export interface ConfigServerErrorShape {
  code: ErrorCode;
  message: string;
  file?: string;
  path?: string;
  field?: string;
  line?: number;
  column?: number;
  remediation?: string;
  // Free-form additional context (tool name, etc.) for code-specific details.
  // Kept narrow on purpose: callers should prefer named fields above.
  [extra: string]: unknown;
}

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

export class ConfigServerError extends Error implements ConfigServerErrorShape {
  public readonly code: ErrorCode;
  public readonly file?: string;
  public readonly path?: string;
  public readonly field?: string;
  public readonly line?: number;
  public readonly column?: number;
  public readonly remediation?: string;
  // Index signature so `[extra: string]: unknown` from the interface holds.
  [extra: string]: unknown;

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
   * Returns a plain object suitable for JSON serialisation in MCP responses.
   * The class itself serialises identically because every public field is an
   * own enumerable property, but `toJSON()` makes the contract explicit.
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
};

/**
 * Build a structured config-server error.
 *
 * @param code one of F2's enumerated error codes
 * @param details optional override fields; if `message` is omitted, a
 *   sensible default is used so every error has a non-empty message
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
