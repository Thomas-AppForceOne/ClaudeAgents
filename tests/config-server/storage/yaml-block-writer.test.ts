// Covers writeYamlBlock — the minimal-edit writer for frontmatter files. Its
// contract: when the new data is structurally equal to what was parsed (whether
// the same object reference or a fresh equal object), return the ORIGINAL
// source byte-for-byte (no spurious reserialisation/diff). When the data
// genuinely changes, re-emit canonical YAML for the block but preserve the
// markdown prose after the block byte-identically (the user's headings, HTML
// comments, and bullet lists must survive). A parse→mutate→write→parse round
// trip confirms prose is stable and the mutation took effect. The null-body and
// single-line-body cases pin the degenerate inputs.
//
// Note: strings like '<!-- a comment -->' and '# Heading' below are FIXTURE
// FILE CONTENT (markdown prose under test), not comments on this test file.
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

    // A freshly-built object (different reference) but structurally equal to the
    // parsed data must still trigger the no-op path: equality is by value, so
    // the original bytes are returned unchanged.
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

    // Prose after the block survives byte-identically even though the block was
    // re-emitted, and the mutated value is present.
    expect(out.endsWith(expectedAfter)).toBe(true);

    expect(out).toContain('name: y');

    // The output still has a well-formed open/close marker pair (open before
    // close), so the frontmatter structure is intact after the edit.
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

    // Re-parsing the written output shows identical prose on both sides and the
    // mutated value, proving the parse→mutate→write→parse cycle is stable.
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
    // A null body that stays null is a no-op: the original source (markers +
    // prose) round-trips byte-for-byte.
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

    expect(out.endsWith(parsed.prose.after)).toBe(true);
  });
});
