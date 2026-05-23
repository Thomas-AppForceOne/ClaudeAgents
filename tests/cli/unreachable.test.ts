
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runGan } from './helpers/spawn.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const c of cleanups.splice(0)) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

function buildBrokenDist(): string {
  const tmp = mkdtempSync(path.join(tmpdir(), 'gan-unreachable-'));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

  const tmpPkg = {
    name: 'gan-unreachable-fixture',
    type: 'module',
  };
  writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(tmpPkg, null, 2) + '\n');

  symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

  const distSrc = path.join(repoRoot, 'dist', 'cli');
  const distDest = path.join(tmp, 'dist', 'cli');
  cpSync(distSrc, distDest, { recursive: true });

  const csDir = path.join(tmp, 'dist', 'config-server');
  const csDeterminismDir = path.join(csDir, 'determinism');
  cpSync(path.join(repoRoot, 'dist', 'config-server', 'determinism'), csDeterminismDir, {
    recursive: true,
  });

  cpSync(path.join(repoRoot, 'dist', 'config-server', 'errors.js'), path.join(csDir, 'errors.js'));
  cpSync(
    path.join(repoRoot, 'dist', 'config-server', 'errors.d.ts'),
    path.join(csDir, 'errors.d.ts'),
  );
  writeFileSync(
    path.join(csDir, 'index.js'),
    `export async function getApiVersion() {
  throw new Error('framework library missing (test stub)');
}
`,
  );
  writeFileSync(
    path.join(csDir, 'index.d.ts'),
    'export function getApiVersion(): Promise<{apiVersion:string}>;\n',
  );

  const csStorageDir = path.join(csDir, 'storage');
  mkdirSync(csStorageDir, { recursive: true });
  writeFileSync(
    path.join(csStorageDir, 'atomic-write.js'),
    `export function atomicWriteFile() { throw new Error('framework library missing (test stub)'); }\n`,
  );
  writeFileSync(
    path.join(csStorageDir, 'atomic-write.d.ts'),
    'export function atomicWriteFile(target: string, content: string): void;\n',
  );

  writeFileSync(
    path.join(csDir, 'package-root.js'),
    `export function packageRoot() { throw new Error('framework library missing (test stub)'); }\n`,
  );
  writeFileSync(path.join(csDir, 'package-root.d.ts'), 'export function packageRoot(): string;\n');
  writeFileSync(
    path.join(csStorageDir, 'yaml-block-parser.js'),
    `export function parseYamlBlock() { throw new Error('framework library missing (test stub)'); }\n`,
  );
  writeFileSync(
    path.join(csStorageDir, 'yaml-block-parser.d.ts'),
    'export function parseYamlBlock(text: string, filePath?: string): unknown;\n',
  );

  writeFileSync(
    path.join(csDir, 'scaffold-banner.js'),
    `export const DRAFT_BANNER = '# DRAFT (test-stub)';\n`,
  );
  writeFileSync(path.join(csDir, 'scaffold-banner.d.ts'), 'export const DRAFT_BANNER: string;\n');

  const distIndex = path.join(tmp, 'dist', 'index.js');
  writeFileSync(
    distIndex,
    [
      'function unreachable() {',
      "  throw new Error('framework library missing (test stub)');",
      '}',
      'export const getResolvedConfig = unreachable;',
      'export const getActiveStacks = unreachable;',
      'export const getStack = unreachable;',
      'export const listModules = unreachable;',
      'export const getOverlay = unreachable;',
      'export const getStackResolution = unreachable;',
      'export const getMergedSplicePoints = unreachable;',
      'export const getModuleState = unreachable;',
      'export const getTrustState = unreachable;',
      'export const getTrustDiff = unreachable;',

      'export const setOverlayField = unreachable;',
      'export const updateStackField = unreachable;',

      'export const validateAll = unreachable;',

      'export const trustApprove = unreachable;',
      'export const trustRevoke = unreachable;',
      'export const trustList = unreachable;',
      'export { getApiVersion } from "./config-server/index.js";',
      '',
    ].join('\n'),
  );

  return path.join(tmp, 'dist', 'cli', 'index.js');
}

describe('gan: framework library unreachable', () => {
  it('F-AC6: `gan version` exits 5 with a remediation hint pointing at install.sh', async () => {
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version'], { entryOverride: brokenEntry });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot reach the framework's library");
    expect(r.stderr).toContain('install.sh');
  });

  it('F-AC6: even with --json, the unreachable error surfaces on stderr (no JSON on stdout)', async () => {

    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version', '--json'], { entryOverride: brokenEntry });
    expect(r.exitCode).toBe(5);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("cannot reach the framework's library");
  });

  it('F-AC6: remediation text obeys the F4 prose discipline', async () => {
    const brokenEntry = buildBrokenDist();
    const r = await runGan(['version'], { entryOverride: brokenEntry });

    const proseToken = /(?<!`)\b(npm|node|Node|MCP server)\b(?!`)/g;
    const violations = [...r.stderr.matchAll(proseToken)];
    expect(violations).toHaveLength(0);

    expect(r.stderr).toMatch(/framework/i);
  });

  const READ_COMMANDS: Array<{ name: string; argv: string[] }> = [
    {
      name: 'config print',
      argv: [
        'config',
        'print',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'config get',
      argv: [
        'config',
        'get',
        'apiVersion',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'stacks list',
      argv: [
        'stacks',
        'list',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'stack show',
      argv: [
        'stack',
        'show',
        'web-node',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'modules list',
      argv: [
        'modules',
        'list',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },

    {
      name: 'config set',
      argv: [
        'config',
        'set',
        'runner.thresholdOverride',
        '8',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
    {
      name: 'stack update',
      argv: [
        'stack',
        'update',
        'web-node',
        'lintCmd',
        'whatever',
        '--project-root',
        path.join(repoRoot, 'tests/fixtures/stacks/js-ts-minimal'),
      ],
    },
  ];

  for (const c of READ_COMMANDS) {
    it(`F-AC6: \`gan ${c.name}\` exits 5 under unreachable framework library`, async () => {
      const brokenEntry = buildBrokenDist();
      const r = await runGan(c.argv, { entryOverride: brokenEntry });
      expect(r.exitCode).toBe(5);

      expect(r.stderr).toContain("cannot reach the framework's library");
      expect(r.stderr).toContain('install.sh');

      expect(r.stdout).toBe('');
    });

    it(`F-AC6: \`gan ${c.name} --json\` exits 5 with structured error on stdout`, async () => {
      const brokenEntry = buildBrokenDist();
      const r = await runGan([...c.argv, '--json'], { entryOverride: brokenEntry });
      expect(r.exitCode).toBe(5);

      expect(r.stderr).toBe('');
      const parsed = JSON.parse(r.stdout) as { code: string; message: string };
      expect(parsed.code).toBe('ApiUnreachable');
      expect(parsed.message).toContain("cannot reach the framework's library");
    });
  }

  it('sanity: the test fixture references real paths', () => {
    const cliEntry = path.join(repoRoot, 'dist', 'cli', 'index.js');
    const head = readFileSync(cliEntry, 'utf8').slice(0, 50);
    expect(head).toContain('#!/usr/bin/env');
  });
});
