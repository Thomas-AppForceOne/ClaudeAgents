// Verifies loadStack against fixtures: it resolves and parses a stack file
// (reporting its source tier + path and the parsed data) and throws MissingFile
// when the named stack exists in no tier. The invalid-schemaVersion case pins a
// deliberate separation of concerns: the loader PARSES but does not VALIDATE —
// a schemaVersion of 999 loads without crashing because schema validation is
// owned by a later stage (S3), not the loader.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigServerError } from '../../../src/config-server/errors.js';
import { loadStack } from '../../../src/config-server/storage/stack-loader.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const jsTsMinimal = path.join(repoRoot, 'tests', 'fixtures', 'stacks', 'js-ts-minimal');
const invalidFixture = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'stacks',
  'invalid-stack-resolution',
);

describe('loadStack', () => {
  it('loads and parses web-node from the js-ts-minimal fixture (built-in tier)', () => {
    const result = loadStack('web-node', jsTsMinimal);
    expect(result.sourceTier).toBe('builtin');
    expect(result.sourcePath).toBe(path.join(jsTsMinimal, 'stacks', 'web-node.md'));
    expect(result.data).toBeTypeOf('object');
    const data = result.data as Record<string, unknown>;
    expect(data.name).toBe('web-node');
    expect(data.schemaVersion).toBe(1);
    expect(Array.isArray(data.scope)).toBe(true);
  });

  it('loads the invalid-schemaVersion fixture without crashing (S3 owns validation)', () => {
    const result = loadStack('web-node', invalidFixture);
    expect(result.sourceTier).toBe('builtin');
    const data = result.data as Record<string, unknown>;

    // The out-of-range schemaVersion is loaded verbatim, not rejected: the
    // loader's job is to parse, and validation is deferred to S3.
    expect(data.schemaVersion).toBe(999);
  });

  it('throws MissingFile via createError when the stack does not exist anywhere', () => {
    try {
      loadStack('does-not-exist', jsTsMinimal);
      throw new Error('expected MissingFile');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('MissingFile');
    }
  });
});
