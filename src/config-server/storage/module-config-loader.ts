/**
 * Per-module project-config loader (M2).
 *
 * Modules expose project-specific config via
 * `<projectRoot>/.claude/gan/modules/<name>.yaml`. This loader parses
 * that file (when present) into a plain object so the resolved-config
 * layer can spread its fields onto `ResolvedConfig.modules.<name>`.
 *
 * The format is plain YAML (not the `---`-bracketed YAML block used by
 * stack/overlay markdown files), so we use the `yaml` package directly
 * rather than the `yaml-block-parser` helper. The package is already
 * a project dependency (used by `yaml-block-parser`); this loader adds
 * no new runtime dependency.
 *
 * Returns `null` when the file does not exist (the module simply has
 * no project-tier config). Throws via the central error factory when
 * the file is unreadable or fails to parse.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { createError } from '../errors.js';

/** Resolve the on-disk per-module config path for a module name. */
export function moduleConfigPath(projectRoot: string, name: string): string {
  return path.join(projectRoot, '.claude', 'gan', 'modules', `${name}.yaml`);
}

/**
 * Load and parse `<projectRoot>/.claude/gan/modules/<name>.yaml`. Returns
 * `null` when the file is absent. Returns the parsed YAML body
 * otherwise. Throws `MalformedInput` / `InvalidYAML` on read or parse
 * failure (no silent swallowing).
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
