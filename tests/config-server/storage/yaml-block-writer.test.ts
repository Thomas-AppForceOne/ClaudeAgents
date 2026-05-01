import { describe, expect, it } from 'vitest';

import { parseYamlBlock } from '../../../src/config-server/storage/yaml-block-parser.js';
import { writeYamlBlock } from '../../../src/config-server/storage/yaml-block-writer.js';

describe('writeYamlBlock', () => {
  it('returns the original source byte-for-byte when data is unchanged (same reference)', () => {
    const text = ['---', 'name: web-node', 'schemaVersion: 1', '---', '', '# web-node', ''].join(
      '\n',
    );
    const parsed = parseYamlBlock(text);
    const out = writeYamlBlock({
      originalSource: text,
      originalParse: parsed,
      newData: parsed.data,
    });
    expect(out).toBe(text);
  });

  it('returns the original source byte-for-byte when data is structurally equal (different reference)', () => {
    const text = [
      '---',
      'name: web-node',
      'schemaVersion: 1',
      'scope:',
      '  - "**/*.ts"',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    const parsed = parseYamlBlock(text);
    // Build a *new* object with the same content, in the same key order.
    const same = {
      name: 'web-node',
      schemaVersion: 1,
      scope: ['**/*.ts'],
    };
    const out = writeYamlBlock({
      originalSource: text,
      originalParse: parsed,
      newData: same,
    });
    expect(out).toBe(text);
  });

  it('preserves prose byte-identically and re-emits canonical YAML when data changes', () => {
    // Note: the closing `---\n` itself is the closeMarker; prose.after
    // starts on the *next* line.
    const text =
      '---\nname: x\nschemaVersion: 1\n---\n\n# Conventions\n\nProse with an apostrophe and a *character*.\n';
    const parsed = parseYamlBlock(text);
    const expectedAfter = '\n# Conventions\n\nProse with an apostrophe and a *character*.\n';
    expect(parsed.prose.before).toBe('');
    expect(parsed.prose.after).toBe(expectedAfter);

    const data = parsed.data as Record<string, unknown>;
    const mutated = { ...data, name: 'y' };
    const out = writeYamlBlock({
      originalSource: text,
      originalParse: parsed,
      newData: mutated,
    });

    // Prose-after survives byte-identically (no leading prose in this
    // fixture, so the prose-before check is a no-op).
    expect(out.endsWith(expectedAfter)).toBe(true);
    // YAML body contains the mutated value.
    expect(out).toContain('name: y');
    // Canonical markers.
    const idxOpen = out.indexOf('---\n');
    const idxClose = out.indexOf('---\n', idxOpen + 4);
    expect(idxOpen).toBeGreaterThanOrEqual(0);
    expect(idxClose).toBeGreaterThan(idxOpen);
  });

  it('round-trips through parse → mutate → write → parse with preserved prose', () => {
    const text = [
      '---',
      'name: alpha',
      'schemaVersion: 1',
      'scope:',
      '  - "**/*.ts"',
      '---',
      '',
      '# Body',
      '',
      'Some text.',
      '',
    ].join('\n');
    const parsed1 = parseYamlBlock(text);
    const data1 = parsed1.data as Record<string, unknown>;
    const mutated = { ...data1, name: 'beta' };
    const out1 = writeYamlBlock({
      originalSource: text,
      originalParse: parsed1,
      newData: mutated,
    });

    // Re-parse the result and check prose still matches.
    const parsed2 = parseYamlBlock(out1);
    expect(parsed2.prose.before).toBe(parsed1.prose.before);
    expect(parsed2.prose.after).toBe(parsed1.prose.after);
    expect((parsed2.data as Record<string, unknown>).name).toBe('beta');
  });

  it('handles a single-line YAML body', () => {
    const text = '---\nname: x\n---\n';
    const parsed = parseYamlBlock(text);
    const out = writeYamlBlock({
      originalSource: text,
      originalParse: parsed,
      newData: parsed.data,
    });
    expect(out).toBe(text);
  });

  it('handles a YAML body where data is empty (null) and unchanged', () => {
    const text = '---\n---\n# body\n';
    const parsed = parseYamlBlock(text);
    expect(parsed.data).toBeNull();
    const out = writeYamlBlock({
      originalSource: text,
      originalParse: parsed,
      newData: null,
    });
    expect(out).toBe(text);
  });

  it('preserves prose around a multi-line markdown body with comments', () => {
    const text = [
      '---',
      'name: stack-x',
      'schemaVersion: 1',
      '---',
      '',
      '# Heading',
      '',
      '<!-- a comment -->',
      '',
      '- bullet',
      '- another',
      '',
    ].join('\n');
    const parsed = parseYamlBlock(text);
    const mutated = { ...(parsed.data as Record<string, unknown>), name: 'stack-y' };
    const out = writeYamlBlock({
      originalSource: text,
      originalParse: parsed,
      newData: mutated,
    });
    expect(out).toContain('# Heading');
    expect(out).toContain('<!-- a comment -->');
    expect(out).toContain('- bullet');
    expect(out).toContain('name: stack-y');
    // The prose between the closing marker and EOF should match exactly.
    expect(out.endsWith(parsed.prose.after)).toBe(true);
  });
});
