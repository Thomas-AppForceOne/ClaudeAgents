
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

const SHARED = 'shared-setup.yml';
const CATEGORY_WORKFLOWS = [
  'test-modules.yml',
  'test-evaluator-pipeline.yml',
  'test-stack-lint.yml',
  'test-schemas.yml',
  'test-no-stack-leak.yml',
  'test-error-text.yml',
] as const;
const EXPECTED_FILES = [SHARED, ...CATEGORY_WORKFLOWS].sort();

function readWorkflow(filename: string): string {
  return readFileSync(path.join(WORKFLOWS_DIR, filename), 'utf8');
}

function loadPackageScripts(): Record<string, string> {
  const pkgRaw = readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

function triggerNames(parsed: unknown): Set<string> {
  if (parsed === null || typeof parsed !== 'object') {
    return new Set();
  }
  const obj = parsed as Record<string, unknown>;
  const onValue = 'on' in obj ? obj.on : obj.true;
  if (onValue === null || onValue === undefined) {
    return new Set();
  }
  if (typeof onValue === 'string') {
    return new Set([onValue]);
  }
  if (Array.isArray(onValue)) {
    return new Set(onValue.filter((x): x is string => typeof x === 'string'));
  }
  if (typeof onValue === 'object') {
    return new Set(Object.keys(onValue as Record<string, unknown>));
  }
  return new Set();
}

function nodeVersionInRange(version: string): boolean {
  const parts = version
    .trim()
    .replace(/^v/, '')
    .split('.')
    .map((p) => p.toLowerCase());

  const [majS, minS = '0', patS = '0'] = parts;
  if (majS === undefined) return false;

  const major = Number(majS);
  if (!Number.isFinite(major)) return false;

  const minor = minS === 'x' ? 10 : Number(minS);
  const patch = patS === 'x' ? 0 : Number(patS);
  if (!Number.isFinite(minor) || !Number.isFinite(patch)) return false;

  const geLower =
    major > 20 || (major === 20 && minor > 10) || (major === 20 && minor === 10 && patch >= 0);

  const ltUpper = major < 23;

  return geLower && ltUpper;
}

describe('workflows: directory layout', () => {
  it('contains exactly the seven expected `.yml` files', () => {
    const entries = readdirSync(WORKFLOWS_DIR).sort();
    expect(entries).toEqual(EXPECTED_FILES);
  });

  for (const filename of EXPECTED_FILES) {
    it(`includes ${filename}`, () => {

      const contents = readWorkflow(filename);
      expect(contents.length).toBeGreaterThan(0);
    });
  }

  it('has no `.yaml` (long-extension) files', () => {
    const entries = readdirSync(WORKFLOWS_DIR);
    const yamlExt = entries.filter((e) => e.endsWith('.yaml'));
    expect(yamlExt).toEqual([]);
  });
});

describe('workflows: shared-setup.yml', () => {
  const raw = readWorkflow(SHARED);
  const parsed = parseYaml(raw) as Record<string, unknown>;

  it('parses as YAML', () => {
    expect(parsed).toBeTypeOf('object');
    expect(parsed).not.toBeNull();
  });

  it('triggers on workflow_call', () => {
    const triggers = triggerNames(parsed);
    expect(triggers.has('workflow_call')).toBe(true);
  });

  it('contains a `node-version:` substring', () => {
    expect(raw).toContain('node-version:');
  });

  it('pins Node version in [20.10.0, 23.0.0)', () => {

    const m = raw.match(/node-version:\s*['"]?([^'"\s]+)['"]?/);
    expect(m).not.toBeNull();
    const version = m![1];
    expect(nodeVersionInRange(version)).toBe(true);
  });

  it('runs `npm ci`', () => {
    expect(raw).toContain('npm ci');
  });

  it('runs `npm run build`', () => {
    expect(raw).toContain('npm run build');
  });
});

describe('workflows: category workflows', () => {
  const scripts = loadPackageScripts();

  for (const filename of CATEGORY_WORKFLOWS) {
    describe(filename, () => {
      const raw = readWorkflow(filename);
      const parsed = parseYaml(raw) as Record<string, unknown>;

      it('parses as YAML', () => {
        expect(parsed).toBeTypeOf('object');
        expect(parsed).not.toBeNull();
      });

      it('triggers on both push and pull_request', () => {
        const triggers = triggerNames(parsed);
        expect(triggers.has('push')).toBe(true);
        expect(triggers.has('pull_request')).toBe(true);
      });

      it('references the shared-setup reusable workflow', () => {
        expect(raw).toContain('uses: ./.github/workflows/shared-setup.yml');
      });

      it('does NOT contain `node-version:`', () => {
        expect(raw).not.toContain('node-version:');
      });

      it('does NOT contain `setup-node`', () => {
        expect(raw).not.toContain('setup-node');
      });

      it('every `npm run <name>` references a real script', () => {
        const re = /npm run ([A-Za-z0-9:_\-]+)/g;
        const referenced = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          referenced.add(m[1]);
        }
        for (const name of referenced) {
          expect(
            scripts,
            `workflow ${filename} references unknown npm script: ${name}`,
          ).toHaveProperty(name);
        }
      });
    });
  }
});

describe('workflows: per-file command substrings', () => {
  it('test-modules.yml runs `npm test`', () => {
    const raw = readWorkflow('test-modules.yml');
    expect(raw).toContain('npm test');
  });

  it('test-evaluator-pipeline.yml runs `npm run evaluator-pipeline-check`', () => {
    const raw = readWorkflow('test-evaluator-pipeline.yml');
    expect(raw).toContain('npm run evaluator-pipeline-check');
  });

  it('test-stack-lint.yml runs `npm run lint-stacks` and `npm run pair-names`', () => {
    const raw = readWorkflow('test-stack-lint.yml');
    expect(raw).toContain('npm run lint-stacks');
    expect(raw).toContain('npm run pair-names');
  });

  it('test-schemas.yml runs `npm run publish-schemas:check`', () => {
    const raw = readWorkflow('test-schemas.yml');
    expect(raw).toContain('npm run publish-schemas:check');
  });

  it('test-no-stack-leak.yml runs `npm run lint-no-stack-leak`', () => {
    const raw = readWorkflow('test-no-stack-leak.yml');
    expect(raw).toContain('npm run lint-no-stack-leak');
  });

  it('test-error-text.yml runs `npm run lint-error-text`', () => {
    const raw = readWorkflow('test-error-text.yml');
    expect(raw).toContain('npm run lint-error-text');
  });
});

describe('workflows: hygiene', () => {
  it('no workflow contains an absolute filesystem path', () => {

    for (const filename of EXPECTED_FILES) {
      const raw = readWorkflow(filename);

      const lines = raw.split('\n');
      for (const line of lines) {
        const m = line.match(/^\s*[A-Za-z_-]+:\s+(\S+)/);
        if (!m) continue;
        const value = m[1];
        if (value.startsWith('/') && !value.startsWith('//')) {
          throw new Error(`${filename}: absolute path detected on line: ${line.trim()}`);
        }
      }
    }
  });
});
