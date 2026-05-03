import { describe, expect, it } from 'vitest';

import { ConfigServerError } from '../../../src/config-server/errors.js';
import {
  parseYamlBlock,
  serializeYamlBlock,
} from '../../../src/config-server/storage/yaml-block-parser.js';

describe('parseYamlBlock', () => {
  it('parses a well-formed stack file and recovers prose flanking the block', () => {
    const text = [
      '---',
      'name: web-node',
      'schemaVersion: 1',
      '---',
      '',
      '# web-node conventions',
      '',
      'Body text.',
      '',
    ].join('\n');
    const parsed = parseYamlBlock(text);
    expect(parsed.data).toEqual({ name: 'web-node', schemaVersion: 1 });
    expect(parsed.prose.before).toBe('');
    expect(parsed.prose.after).toContain('# web-node conventions');
  });

  it('round-trips byte-for-byte when the data is unchanged', () => {
    const text = [
      '---',
      'name: web-node',
      'schemaVersion: 1',
      'scope:',
      '  - "**/*.ts"',
      '---',
      '',
      '# web-node',
      '',
    ].join('\n');
    const parsed = parseYamlBlock(text);
    const reconstructed =
      parsed.prose.before + serializeYamlBlock(parsed.data, parsed) + parsed.prose.after;
    expect(reconstructed).toBe(text);
  });

  it('preserves prose with leading blank lines before the YAML block', () => {
    const text = ['', '', '---', 'name: x', 'schemaVersion: 1', '---', '', 'body', ''].join('\n');
    const parsed = parseYamlBlock(text);
    expect(parsed.prose.before).toBe('\n\n');
    const reconstructed =
      parsed.prose.before + serializeYamlBlock(parsed.data, parsed) + parsed.prose.after;
    expect(reconstructed).toBe(text);
  });

  it('parses an empty YAML body to null', () => {
    const text = ['---', '---', 'body', ''].join('\n');
    const parsed = parseYamlBlock(text);
    expect(parsed.data).toBeNull();
    expect(parsed.raw).toBe('');
  });

  it('throws InvalidYAML on malformed YAML', () => {
    const text = ['---', 'name: x', 'broken: [', '---'].join('\n');
    expect(() => parseYamlBlock(text)).toThrowError(ConfigServerError);
    try {
      parseYamlBlock(text);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('InvalidYAML');
    }
  });

  it('throws MissingFile on empty input', () => {
    try {
      parseYamlBlock('');
      throw new Error('expected MissingFile');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('MissingFile');
    }
  });

  it('throws MalformedInput when the opening marker is missing', () => {
    const text = '# Just prose\n\nNo frontmatter here.\n';
    try {
      parseYamlBlock(text);
      throw new Error('expected MalformedInput');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('MalformedInput');
    }
  });

  it('throws MalformedInput when the closing marker is missing', () => {
    const text = '---\nname: x\nschemaVersion: 1\n\n# body never closes\n';
    try {
      parseYamlBlock(text);
      throw new Error('expected MalformedInput');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigServerError);
      expect((e as ConfigServerError).code).toBe('MalformedInput');
    }
  });

  it('threads filePath through to the error context', () => {
    try {
      parseYamlBlock('', '/tmp/empty.md');
      throw new Error('expected MissingFile');
    } catch (e) {
      expect((e as ConfigServerError).file).toBe('/tmp/empty.md');
    }
  });
});

describe('serializeYamlBlock', () => {
  it('emits canonical markers when called without the parsed reference', () => {
    const out = serializeYamlBlock({ name: 'x', schemaVersion: 1 });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.endsWith('---\n')).toBe(true);
  });

  it('emits exact original bytes when called with the parsed reference and unchanged data', () => {
    const text = '---\nname: x\nschemaVersion: 1\n---\nbody\n';
    const parsed = parseYamlBlock(text);
    const block = serializeYamlBlock(parsed.data, parsed);
    expect(parsed.prose.before + block + parsed.prose.after).toBe(text);
  });
});
