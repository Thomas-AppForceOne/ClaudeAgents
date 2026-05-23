

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

  path: string;

  tier: OverlayTier;

  raw: string;
}

export interface LoadOverlayOptions {

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
