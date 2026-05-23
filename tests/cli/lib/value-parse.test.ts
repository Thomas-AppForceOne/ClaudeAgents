// Tests for `parseCliValue`, the converter behind CLI commands that take a
// `--value`. The contract is "JSON-first with a bare-string fallback": a token
// that parses as JSON becomes that typed value (boolean, number, null, array,
// object, or the inner string of a quoted literal), and a token that does NOT
// parse as JSON is returned verbatim as a string. This lets users pass typed
// config without quoting, while shell-friendly bare values like `docs/notes.md`
// or `0xff` (not valid JSON) still round-trip as plain strings.

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

    expect(parseCliValue('"hello"')).toBe('hello');
    expect(parseCliValue('""')).toBe('');
  });

  it('falls back to bare strings when JSON parse fails', () => {
    expect(parseCliValue('hello')).toBe('hello');
    expect(parseCliValue('docs/notes.md')).toBe('docs/notes.md');

    // Has an interior space, so it is not a valid JSON token: kept verbatim
    // (a command string the user typed, e.g. for a `testCmd` field).
    expect(parseCliValue('vitest run')).toBe('vitest run');

    // `0xff` is a number to a human but NOT valid JSON (JSON has no hex), so the
    // fallback preserves it as the literal string rather than guessing 255.
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
    // Surrounding whitespace is insignificant to JSON.parse, so a padded number
    // token still yields the number — the shell may leave such padding behind.
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
