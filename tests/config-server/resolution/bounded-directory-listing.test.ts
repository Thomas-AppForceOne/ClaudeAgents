// Unit tests for buildBoundedDirectoryListing — the structure-only, scope-bounded
// view the clarifier consumes. Three properties are guarded, each one a piece of
// the clarifier's trust posture:
//   - SCOPE FILTERING: only files matching an active-stack glob appear; a file
//     outside every glob is absent, so the clarifier cannot enumerate paths the
//     stacks do not own.
//   - STRUCTURE ONLY: the result carries directory names and file paths but no
//     file contents — verified both by inspecting the result shape and by
//     planting a unique byte sequence in a file and asserting it never appears in
//     the serialised listing, so the listing cannot become an exfiltration channel.
//   - FAULT TOLERANCE: a non-existent root, and an entry that fails to stat,
//     degrade to an empty/partial listing rather than throwing.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildBoundedDirectoryListing } from '../../../src/config-server/resolution/bounded-directory-listing.js';

const tmpDirs: string[] = [];

// Build a small project tree with a mix of in-scope (.ts/.tsx) and out-of-scope
// (.md/.png) files across nested directories, returning the project root.
function makeProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bounded-listing-'));
  mkdirSync(path.join(root, 'src', 'auth'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(root, 'src', 'auth', 'sign-in.ts'), 'export const y = 2;\n');
  writeFileSync(path.join(root, 'src', 'auth', 'view.tsx'), 'export const z = 3;\n');
  writeFileSync(path.join(root, 'docs', 'guide.md'), '# guide\n');
  writeFileSync(path.join(root, 'assets', 'logo.png'), 'PNGDATA\n');
  tmpDirs.push(root);
  return root;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('buildBoundedDirectoryListing — scope filtering', () => {
  it('includes only files matching an active-stack glob; out-of-scope paths are absent', () => {
    const root = makeProject();
    const listing = buildBoundedDirectoryListing(root, ['**/*.ts', '**/*.tsx']);

    expect(listing.scopedFiles).toEqual([
      'src/auth/sign-in.ts',
      'src/auth/view.tsx',
      'src/index.ts',
    ]);
    // Out-of-scope extensions never appear, regardless of directory.
    expect(listing.scopedFiles).not.toContain('docs/guide.md');
    expect(listing.scopedFiles).not.toContain('assets/logo.png');
    expect(listing.scopedFiles.some((p) => p.endsWith('.md'))).toBe(false);
    expect(listing.scopedFiles.some((p) => p.endsWith('.png'))).toBe(false);
  });

  it('reports the project top-level directory names regardless of scope', () => {
    const root = makeProject();
    const listing = buildBoundedDirectoryListing(root, ['**/*.ts']);
    expect(listing.topLevelDirectories).toEqual(['assets', 'docs', 'src']);
  });

  it('an empty glob list matches no files (top-level dirs still reported)', () => {
    const root = makeProject();
    const listing = buildBoundedDirectoryListing(root, []);
    expect(listing.scopedFiles).toEqual([]);
    expect(listing.topLevelDirectories).toEqual(['assets', 'docs', 'src']);
  });
});

describe('buildBoundedDirectoryListing — structure only', () => {
  it('returns directory names and file paths but no file contents', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bounded-listing-content-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    // A unique marker that must never surface in the listing if only structure
    // (paths/names), not bytes, is gathered.
    const secret = 'UNIQUE_SECRET_MARKER_4f2a';
    writeFileSync(path.join(root, 'src', 'secret.ts'), `const token = '${secret}';\n`);
    tmpDirs.push(root);

    const listing = buildBoundedDirectoryListing(root, ['**/*.ts']);
    expect(listing.scopedFiles).toEqual(['src/secret.ts']);
    // The file's contents must be nowhere in the serialised result: the listing
    // gathers paths/names, never bytes, so the marker cannot have leaked in.
    expect(JSON.stringify(listing)).not.toContain(secret);
  });
});

describe('buildBoundedDirectoryListing — fault tolerance', () => {
  it('a non-existent project root yields an empty listing rather than throwing', () => {
    const missing = path.join(tmpdir(), 'definitely-not-a-real-dir-9a8b7c');
    expect(() => buildBoundedDirectoryListing(missing, ['**/*.ts'])).not.toThrow();
    const listing = buildBoundedDirectoryListing(missing, ['**/*.ts']);
    expect(listing).toEqual({ topLevelDirectories: [], scopedFiles: [] });
  });

  it('a root that is a file (not a directory) degrades to an empty listing', () => {
    // readdirSync on a regular file throws ENOTDIR; the guarded walk must swallow
    // it and return an empty listing rather than propagating the I/O error.
    const root = mkdtempSync(path.join(tmpdir(), 'bounded-listing-file-'));
    const filePath = path.join(root, 'not-a-dir');
    writeFileSync(filePath, 'x\n');
    tmpDirs.push(root);
    expect(() => buildBoundedDirectoryListing(filePath, ['**/*.ts'])).not.toThrow();
    expect(buildBoundedDirectoryListing(filePath, ['**/*.ts'])).toEqual({
      topLevelDirectories: [],
      scopedFiles: [],
    });
  });

  it('a broken symlink entry is skipped (stat failure does not abort the walk)', () => {
    // A dangling symlink fails statSync (which follows links): the per-entry
    // guard must skip it while the real files in the same directory still list.
    const root = mkdtempSync(path.join(tmpdir(), 'bounded-listing-symlink-'));
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'real.ts'), 'export const a = 1;\n');
    symlinkSync(path.join(root, 'src', 'missing-target.ts'), path.join(root, 'src', 'dangling.ts'));
    tmpDirs.push(root);

    let listing: ReturnType<typeof buildBoundedDirectoryListing> | undefined;
    expect(() => {
      listing = buildBoundedDirectoryListing(root, ['**/*.ts']);
    }).not.toThrow();
    // The real file is present; the dangling symlink was skipped, not fatal.
    expect(listing!.scopedFiles).toContain('src/real.ts');
    expect(listing!.scopedFiles).not.toContain('src/dangling.ts');
  });
});
