/**
 * Structural tests for the CI workflow files under `.github/workflows`.
 *
 * The CI surface is a single reusable `shared-setup.yml` plus a set of
 * per-category workflows that all call it. This suite pins that layout and the
 * conventions that keep it consistent: exactly the expected `.yml` files exist
 * (no stray `.yaml`), the shared workflow is `workflow_call`-triggered and pins a
 * Node version in the supported range while running `npm ci` + `npm run
 * build`, every category workflow triggers on push and pull_request, reuses
 * shared-setup, and never re-declares its own Node setup. Each `npm run <name>`
 * a workflow invokes must map to a real `package.json` script, the right
 * per-file command appears in the right workflow, and no workflow hardcodes an
 * absolute filesystem path.
 *
 * Regression guarded: CI drift — a renamed/dropped script, a category workflow
 * that stops reusing shared-setup or re-pins Node itself, a duplicated
 * Node-version definition, or a leaked machine-specific absolute path.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);

const REPO_ROOT = path.resolve(path.dirname(__filename), '..', '..', '..');
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// The one reusable workflow every category workflow calls into.
const SHARED = 'shared-setup.yml';
const CATEGORY_WORKFLOWS = [
  'test-modules.yml',
  'test-evaluator-pipeline.yml',
  'test-stack-lint.yml',
  'test-schemas.yml',
  'test-no-stack-leak.yml',
  'test-no-spec-ref.yml',
  'test-no-second-mcp-server.yml',
  'test-api-tools-v1-r7-entries.yml',
  'test-house-rules.yml',
  'test-error-text.yml',
  'test-doc-lint.yml',
] as const;
const EXPECTED_FILES = [SHARED, ...CATEGORY_WORKFLOWS].sort();

// Read a workflow file's raw text. Tests assert on both the parsed YAML and
// the raw string (some checks are substring/structural rather than semantic).
function readWorkflow(filename: string): string {
  return readFileSync(path.join(WORKFLOWS_DIR, filename), 'utf8');
}

// The repo's package.json scripts, used to confirm every workflow-invoked
// `npm run <name>` resolves to a real script.
function loadPackageScripts(): Record<string, string> {
  const pkgRaw = readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

// Normalise a parsed workflow's trigger declaration into a set of trigger
// names, tolerating the three YAML shapes (a single string, a list, or a
// mapping). The bare-word key `on` is parsed by the YAML lib as the boolean
// true, so when `on` is absent we fall back to the `true` property — both name
// the same trigger block.
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

// Accept a Node version string if it falls in the supported half-open range
// 20.10.0 (inclusive) up to 23.0.0 (exclusive). A leading v is stripped, and a
// wildcard minor/patch (x) is treated as a permissive in-range value so a pin
// like 20.x still passes the lower bound.
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

  // Lower bound: >= 20.10.0, expanded to avoid relying on a tuple comparison.
  const geLower =
    major > 20 || (major === 20 && minor > 10) || (major === 20 && minor === 10 && patch >= 0);

  // Upper bound: strictly below the next major (23).
  const ltUpper = major < 23;

  return geLower && ltUpper;
}

describe('workflows: directory layout', () => {
  it('contains exactly the expected `.yml` files', () => {
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
        // Scrape every `npm run <name>` invocation from the raw workflow and
        // require each name to exist in package.json scripts.
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

  it('test-no-spec-ref.yml runs `npm run lint-no-spec-ref`', () => {
    const raw = readWorkflow('test-no-spec-ref.yml');
    expect(raw).toContain('npm run lint-no-spec-ref');
  });

  it('test-house-rules.yml runs `npm run house-rules`', () => {
    const raw = readWorkflow('test-house-rules.yml');
    expect(raw).toContain('npm run house-rules');
  });

  it('test-error-text.yml runs `npm run lint-error-text`', () => {
    const raw = readWorkflow('test-error-text.yml');
    expect(raw).toContain('npm run lint-error-text');
  });

  it('test-doc-lint.yml runs `npm run doc-lint`', () => {
    const raw = readWorkflow('test-doc-lint.yml');
    expect(raw).toContain('npm run doc-lint');
  });

  it('test-api-tools-v1-r7-entries.yml runs `npm run api-tools-v1-r7-entries`', () => {
    const raw = readWorkflow('test-api-tools-v1-r7-entries.yml');
    expect(raw).toContain('npm run api-tools-v1-r7-entries');
  });
});

describe('workflows: hygiene', () => {
  it('no workflow contains an absolute filesystem path', () => {
    // Scan every `key: value` line for a value that looks like an absolute
    // filesystem path. A leading-slash value is flagged, except a protocol-less
    // URL (leading double-slash) which is not a local path.
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
