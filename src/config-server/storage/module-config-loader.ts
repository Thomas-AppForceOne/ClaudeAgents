

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { createError } from '../errors.js';

export function moduleConfigPath(projectRoot: string, name: string): string {
  return path.join(projectRoot, '.claude', 'gan', 'modules', `${name}.yaml`);
}

export function loadModuleConfig(projectRoot: string, name: string): unknown {
  const file = moduleConfigPath(projectRoot, name);
  if (!existsSync(file)) return null;
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    throw createError('MalformedInput', {
      file,
      message: `The framework could not read module config '${file}': ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }
  try {
    return YAML.parse(raw);
  } catch (e) {
    throw createError('InvalidYAML', {
      file,
      message: `Module config '${file}' is not valid YAML: ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }
}
