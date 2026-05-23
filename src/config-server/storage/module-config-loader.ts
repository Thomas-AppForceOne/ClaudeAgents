

/**
 * Locate and load a module's per-project YAML config.
 *
 * Module config lives under `<projectRoot>/.claude/gan/modules/<name>.yaml` and
 * is optional: a module with no config file is a normal state (the absence
 * returns `null`, not an error). Distinct from module *state* (which the
 * framework writes) and the module *manifest* (which ships with the module) —
 * this is user-authored config the module reads at runtime.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { createError } from '../errors.js';

/**
 * Build the absolute path to module `name`'s project config file. Pure path
 * construction — does not check existence.
 *
 * @param projectRoot the project directory.
 * @param name the module name (used as the YAML filename stem).
 * @returns `<projectRoot>/.claude/gan/modules/<name>.yaml`.
 */
export function moduleConfigPath(projectRoot: string, name: string): string {
  return path.join(projectRoot, '.claude', 'gan', 'modules', `${name}.yaml`);
}

/**
 * Load and parse module `name`'s project config.
 *
 * @param projectRoot the project directory.
 * @param name the module name.
 * @returns the parsed YAML value (any YAML-representable shape), or `null` when
 *   no config file exists — an absent file is a supported, non-error state.
 *
 * Failure modes (THROWN as `ConfigServerError`, never returned): a read error
 * on an existing file → code `MalformedInput`; content that is not valid YAML →
 * code `InvalidYAML`. Both fold the underlying error text into the message and
 * carry the offending `file` path.
 */
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
