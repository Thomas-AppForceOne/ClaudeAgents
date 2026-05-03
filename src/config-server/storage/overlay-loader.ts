/**
 * Overlay file loader.
 *
 * Loads a tier-specific overlay markdown file (default / user / project)
 * and parses its YAML frontmatter. Returns `null` when the requested tier
 * has no overlay file on disk — overlays are optional at every tier
 * (a project may ship without `.claude/gan/project.md`, a user may not
 * have `~/.claude/gan/user.md`, etc.).
 *
 * Tier file paths (per F1 / C4):
 *   - default — `<projectRoot>/.claude/gan/default.md`
 *     (default overlay is shipped *with* the project until E2 carves it
 *     into a packaged location; for R1 fixtures it lives at the same
 *     project-root location.)
 *   - user    — `<userHome>/.claude/gan/user.md`
 *   - project — `<projectRoot>/.claude/gan/project.md`
 *
 * Trust gating, cascade merging, and tier-specific field rules live in
 * later sprints (S4/S5). This loader is a pure file→data adapter.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { ConfigServerError } from '../errors.js';
import { validateOverlayBodyAgainstSchema, type Issue } from '../validation/schema-check.js';
import { checkUserOverlayForbiddenFields } from '../validation/user-tier-forbidden.js';
import { parseYamlBlock, type YamlBlockProse } from './yaml-block-parser.js';

export type OverlayTier = 'default' | 'user' | 'project';

export interface LoadedOverlay {
  data: unknown;
  prose: YamlBlockProse;
  /** Absolute path to the overlay file that was loaded. */
  path: string;
  /** Tier the overlay was loaded from. */
  tier: OverlayTier;
  /** Raw YAML body bytes (for round-trip writes). */
  raw: string;
}

export interface LoadOverlayOptions {
  /**
   * Override for the user-tier home directory. Same semantics as
   * `resolveStackFile`'s `userHome` parameter.
   */
  userHome?: string;
}

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
 * Load + ajv-validate an overlay tier. On parse or schema failure, returns
 * issues alongside whatever data could be loaded; never throws for
 * `MissingFile` / `InvalidYAML` / `MalformedInput`. Mirrors
 * `loadStackWithValidation`. A missing overlay file is OK at every tier
 * and yields `{ loaded: null, issues: [] }`.
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
  if (tier === 'user') {
    checkUserOverlayForbiddenFields(loaded.path, loaded.data, issues);
  }
  return { loaded, issues };
}

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
