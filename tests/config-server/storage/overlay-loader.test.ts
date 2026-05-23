// Verifies loadOverlay's tier lookup against the js-ts-minimal fixture: the
// project tier loads its overlay (returning tier, resolved path, and parsed
// data), while a tier with no overlay file resolves to null rather than
// throwing — absence is a normal, expected outcome that the cascade handles.
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
    // The fixture ships a project overlay but no default-tier overlay, so the
    // default tier is a clean null.
    const result = loadOverlay('default', jsTsMinimal);
    expect(result).toBeNull();
  });

  it('returns null for the user tier when userHome points to an empty dir', () => {
    // Point userHome at the fixture root, which has no `.claude/gan/user.md`
    // under it, so the user-tier lookup finds nothing and returns null.
    const tmpRoot = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');

    const result = loadOverlay('user', jsTsMinimal, { userHome: tmpRoot });
    expect(result).toBeNull();
  });
});
