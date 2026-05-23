

/**
 * Read-side loader for overlay documents (the counterpart to the overlay write
 * tools in `tools/writes.ts`).
 *
 * Overlays are Markdown files carrying a delimited YAML block; they exist in
 * three tiers — `project` and `default` under the project's `.claude/gan/`, and
 * `user` under the user's home. This module locates the file for a tier, parses
 * its YAML block, and (in the validating variant) checks it against the overlay
 * schema, applying the extra `user`-tier forbidden-field rule.
 *
 * Two error-handling postures coexist here:
 * - {@link loadOverlay} is the raw loader: a parse failure THROWS
 *   `ConfigServerError`, and a missing file returns `null`.
 * - {@link loadOverlayWithValidation} never throws `ConfigServerError`: it
 *   catches it and folds it (with schema issues) into a returned `issues`
 *   array, so callers can present all problems together. Non-`ConfigServerError`
 *   faults still propagate.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigServerError } from '../errors.js';
import { validateOverlayBodyAgainstSchema, type Issue } from '../validation/schema-check.js';
import { checkUserOverlayForbiddenFields } from '../validation/user-tier-forbidden.js';
import { parseYamlBlock, type YamlBlockProse } from './yaml-block-parser.js';

/** The three overlay tiers, lowest to highest specificity in resolution:
 * packaged `default`, the `user`'s home overlay, and the `project` overlay. */
export type OverlayTier = 'default' | 'user' | 'project';

/**
 * A loaded overlay document.
 *
 * @property data the parsed YAML body (any shape, including `null`/`undefined`
 *   for an empty body); not yet schema-validated by {@link loadOverlay}.
 * @property prose the Markdown text surrounding the YAML block, preserved so a
 *   later write can round-trip the file without losing it.
 * @property path absolute path the overlay was read from.
 * @property tier which tier this overlay is.
 * @property raw the raw YAML block text (between the `---` markers).
 */
export interface LoadedOverlay {
  data: unknown;
  prose: YamlBlockProse;

  path: string;

  tier: OverlayTier;

  raw: string;
}

/**
 * Options for overlay loading.
 *
 * @property userHome override for the user's home directory, used only to
 *   locate the `user`-tier overlay. When omitted, the loader falls back to the
 *   `GAN_USER_HOME`/`HOME`/`USERPROFILE` env vars.
 */
export interface LoadOverlayOptions {

  userHome?: string;
}

/**
 * Load and parse the overlay for `tier` without schema validation.
 *
 * @param tier which overlay to load.
 * @param projectRoot the project directory (locates `project`/`default` tiers).
 * @param opts see {@link LoadOverlayOptions}; `userHome` locates the `user` tier.
 * @returns the {@link LoadedOverlay}, or `null` when the tier cannot be located
 *   (e.g. `user` tier with no resolvable home) or the file does not exist —
 *   both are normal "no overlay" states, not errors.
 * @throws `ConfigServerError` when the file exists but its YAML block is
 *   missing/invalid (from {@link parseYamlBlock}).
 */
export function loadOverlay(
  tier: OverlayTier,
  projectRoot: string,
  opts: LoadOverlayOptions = {},
): LoadedOverlay | null {
  const filePath = overlayPath(tier, projectRoot, opts.userHome);
  if (filePath === null) return null;
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, 'utf8');
  const parsed = parseYamlBlock(text, filePath);
  return {
    data: parsed.data,
    prose: parsed.prose,
    path: filePath,
    tier,
    raw: parsed.raw,
  };
}

/**
 * Load the overlay for `tier` and validate it against the overlay schema,
 * collecting all problems as data rather than throwing.
 *
 * @param tier which overlay to load.
 * @param projectRoot the project directory.
 * @param opts see {@link LoadOverlayOptions}.
 * @returns `{ loaded, issues }`. `loaded` is the overlay (or `null` if absent,
 *   or `null` with a populated `issues` when a `ConfigServerError` was caught);
 *   `issues` accumulates parse errors (folded from a caught `ConfigServerError`)
 *   and schema-validation issues, plus the `user`-tier forbidden-field issues
 *   when `tier === 'user'`. An empty `issues` with a non-null `loaded` means a
 *   valid overlay.
 * @throws only re-throws a non-`ConfigServerError` fault from loading; expected
 *   load/parse errors are returned in `issues`, not thrown.
 */
export function loadOverlayWithValidation(
  tier: OverlayTier,
  projectRoot: string,
  opts: LoadOverlayOptions = {},
): { loaded: LoadedOverlay | null; issues: Issue[] } {
  const issues: Issue[] = [];
  let loaded: LoadedOverlay | null;
  try {
    loaded = loadOverlay(tier, projectRoot, opts);
  } catch (e) {
    // Expected file/parse problems arrive as ConfigServerError and become
    // returned issues so the caller sees them alongside schema issues; any
    // other throw is an unexpected fault and must propagate.
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
  if (!loaded) return { loaded: null, issues };
  validateOverlayBodyAgainstSchema(loaded.path, loaded.data, issues);
  // The user tier forbids fields the project/default tiers permit; this extra
  // check only applies there.
  if (tier === 'user') {
    checkUserOverlayForbiddenFields(loaded.path, loaded.data, issues);
  }
  return { loaded, issues };
}

/**
 * Map a tier to its overlay file path. `project`/`default` resolve under the
 * project's `.claude/gan/`; `user` resolves under the user's home, taken from
 * `userHome` or the `GAN_USER_HOME`/`HOME`/`USERPROFILE` env vars.
 *
 * @returns the absolute path, or `null` for the `user` tier when no home can be
 *   determined (the one case a path cannot be formed).
 */
function overlayPath(tier: OverlayTier, projectRoot: string, userHome?: string): string | null {
  switch (tier) {
    case 'project':
      return path.join(projectRoot, '.claude', 'gan', 'project.md');
    case 'default':
      return path.join(projectRoot, '.claude', 'gan', 'default.md');
    case 'user': {
      const home =
        userHome ?? process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
      if (typeof home !== 'string' || home.length === 0) return null;
      return path.join(home, '.claude', 'gan', 'user.md');
    }
  }
}
