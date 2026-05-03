import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadOverlay } from '../../../src/config-server/storage/overlay-loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

describe('loadOverlay', () => {
  it('loads the project-tier overlay from js-ts-minimal', () => {
    const result = loadOverlay('project', jsTsMinimal);
    expect(result).not.toBeNull();
    expect(result!.tier).toBe('project');
    expect(result!.path).toBe(path.join(jsTsMinimal, '.claude', 'gan', 'project.md'));
    const data = result!.data as Record<string, unknown>;
    expect(data.schemaVersion).toBe(1);
  });

  it('returns null when the requested tier has no overlay file', () => {
    // js-ts-minimal does not ship a default-tier overlay.
    const result = loadOverlay('default', jsTsMinimal);
    expect(result).toBeNull();
  });

  it('returns null for the user tier when userHome points to an empty dir', () => {
    const tmpRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');
    // Reuse jsTsMinimal as a "user home" — there is no ~/.claude/gan/user.md
    // in this fixture, so loadOverlay must return null.
    const result = loadOverlay('user', jsTsMinimal, { userHome: tmpRoot });
    expect(result).toBeNull();
  });
});
