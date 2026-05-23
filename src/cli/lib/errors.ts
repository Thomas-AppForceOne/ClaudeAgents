

import { ConfigServerError } from '../../config-server/errors.js';
import { emitJson } from './json-output.js';

export interface RenderableError {
  code: string;
  message: string;
  file?: string;
  path?: string;
  field?: string;
  line?: number;
  column?: number;
  remediation?: string;
  [extra: string]: unknown;
}

function coerce(err: unknown): RenderableError {
  if (err instanceof ConfigServerError) {

    return err.toJSON() as unknown as RenderableError;
  }
  if (isF2Shape(err)) {
    return err;
  }
  if (err instanceof Error) {
    return {
      code: 'NotImplemented',
      message: err.message || 'unknown error',
    };
  }
  return {
    code: 'NotImplemented',
    message: typeof err === 'string' && err.length > 0 ? err : 'unknown error',
  };
}

function isF2Shape(v: unknown): v is RenderableError {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.code === 'string' && typeof r.message === 'string';
}

export function renderErrorJson(err: unknown): string {
  const shape = coerce(err);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(shape)) {
    if (v !== undefined) out[k] = v;
  }
  return emitJson(out);
}

export function renderError(err: unknown): string {
  const shape = coerce(err);
  const lines: string[] = [];
  lines.push(`Error: ${shape.message}`);
  lines.push(`  code: ${shape.code}`);
  if (typeof shape.file === 'string' && shape.file.length > 0) {
    lines.push(`  file: ${shape.file}`);
  } else if (typeof shape.path === 'string' && shape.path.length > 0) {
    lines.push(`  path: ${shape.path}`);
  }
  if (typeof shape.field === 'string' && shape.field.length > 0) {
    lines.push(`  field: ${shape.field}`);
  }
  if (typeof shape.line === 'number') {
    lines.push(`  line: ${shape.line}`);
  }
  if (typeof shape.remediation === 'string' && shape.remediation.length > 0) {
    lines.push(`  remediation: ${shape.remediation}`);
  }
  return lines.join('\n') + '\n';
}
