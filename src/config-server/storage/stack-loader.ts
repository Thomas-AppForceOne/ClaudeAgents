

import { readFileSync } from 'node:fs';

import { ConfigServerError } from '../errors.js';
import {
  resolveStackFile,
  type ResolveStackOptions,
  type StackTier,
} from '../resolution/stack-resolution.js';
import { validateStackBodyAgainstSchema, type Issue } from '../validation/schema-check.js';
import { parseYamlBlock, type YamlBlockProse } from './yaml-block-parser.js';

export interface LoadedStack {

  data: unknown;

  prose: YamlBlockProse;

  sourceTier: StackTier;

  sourcePath: string;

  raw: string;
}

export function loadStack(
  name: string,
  projectRoot: string,
  opts: ResolveStackOptions = {},
): LoadedStack {
  const resolved = resolveStackFile(name, projectRoot, opts);
  const text = readFileSync(resolved.path, 'utf8');
  const parsed = parseYamlBlock(text, resolved.path);
  return {
    data: parsed.data,
    prose: parsed.prose,
    sourceTier: resolved.tier,
    sourcePath: resolved.path,
    raw: parsed.raw,
  };
}

export function loadStackWithValidation(
  name: string,
  projectRoot: string,
  opts: ResolveStackOptions = {},
): { loaded: LoadedStack | null; issues: Issue[] } {
  const issues: Issue[] = [];
  let loaded: LoadedStack;
  try {
    loaded = loadStack(name, projectRoot, opts);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      issues.push({
        code: e.code,
        path: e.file ?? e.path,
        field: e.field,
        message: e.message,
        severity: 'error',
      });
      return { loaded: null, issues };
    }
    throw e;
  }
  validateStackBodyAgainstSchema(loaded.sourcePath, loaded.data, issues);
  return { loaded, issues };
}
