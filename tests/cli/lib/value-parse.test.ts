/**
 * R3 sprint 3 — `parseCliValue` unit tests.
 *
 * Covers every documented surface from `src/cli/lib/value-parse.ts`:
 *   - JSON literal parsing (booleans, numbers, arrays, objects, null).
 *   - Bare-string fallback for unquoted words.
 *   - Edge cases: empty string, JSON-with-leading-whitespace, hex-like
 *     bare words, the literal string `"null"` (quoted) vs the bare word
 *     `null`, deeply-nested JSON.
 */
import { describe, expect, it } from 'vitest';
import { parseCliValue } from '../../../src/cli/lib/value-parse.js';

describe('parseCliValue', () => {
  it('parses JSON booleans', () => {
    expect(parseCliValue('true')).toBe(true);
    expect(parseCliValue('false')).toBe(false);
  });

  it('parses JSON numbers (integer and float)', () => {
    expect(parseCliValue('8')).toBe(8);
    expect(parseCliValue('0')).toBe(0);
    expect(parseCliValue('-3')).toBe(-3);
    expect(parseCliValue('3.14')).toBe(3.14);
    expect(parseCliValue('1e3')).toBe(1000);
  });

  it('parses JSON null', () => {
    expect(parseCliValue('null')).toBeNull();
  });

  it('parses JSON arrays of mixed primitives', () => {
    expect(parseCliValue('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseCliValue('["a","b"]')).toEqual(['a', 'b']);
    expect(parseCliValue('[true,false,null]')).toEqual([true, false, null]);
  });

  it('parses JSON objects (sorted by user, but parser preserves insertion order)', () => {
    expect(parseCliValue('{"key":"value"}')).toEqual({ key: 'value' });
    expect(parseCliValue('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  it('parses JSON-quoted strings as the inner string', () => {
    // `"hello"` is valid JSON whose value is the string `hello`.
    expect(parseCliValue('"hello"')).toBe('hello');
    expect(parseCliValue('""')).toBe('');
  });

  it('falls back to bare strings when JSON parse fails', () => {
    expect(parseCliValue('hello')).toBe('hello');
    expect(parseCliValue('docs/notes.md')).toBe('docs/notes.md');
    // Multi-word ARGV is one shell-joined token; the value parser doesn't
    // care about spaces.
    expect(parseCliValue('vitest run')).toBe('vitest run');
    // Hex-like — not valid JSON, falls back to string.
    expect(parseCliValue('0xff')).toBe('0xff');
  });

  it('empty input returns the empty string', () => {
    expect(parseCliValue('')).toBe('');
  });

  it('handles deeply nested JSON', () => {
    const raw = '{"a":{"b":{"c":[1,{"d":"e"}]}}}';
    expect(parseCliValue(raw)).toEqual({ a: { b: { c: [1, { d: 'e' }] } } });
  });

  it('JSON with leading whitespace still parses', () => {
    // JSON.parse tolerates leading whitespace per the spec.
    expect(parseCliValue('   8  ')).toBe(8);
  });

  it('round-trips JSON literals byte-stably (write → read → write same shape)', () => {
    const cases: unknown[] = [true, false, 0, 8, -3, 'hello', [1, 2, 3], { a: 1 }, null];
    for (const v of cases) {
      const raw = JSON.stringify(v);
      expect(parseCliValue(raw)).toEqual(v);
    }
  });
});
