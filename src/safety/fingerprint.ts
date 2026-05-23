/**
 * Edit-set fingerprinting for the framework-owned oscillation-detection layer
 * (A1, sprint 3 — the normalization machinery only; the directRepeat/3cycle
 * triggers that consume these fingerprints are sprint 4).
 *
 * The fingerprint maps the structural shape of a generator's proposed changes
 * (the paths touched plus the post-edit content of each path) to a single
 * SHA-256 digest. Two edit sets that are *logically* the same change collapse
 * to the same digest so a later attempt that only re-spells the same edit is
 * recognisable as a repeat rather than mistaken for progress.
 *
 * "Logically the same" is defined by three normalization rules the spec pins
 * (A1 § "Edit oscillation detection"), each applied independently per file:
 *
 *  1. Whitespace-only differences collapse. Language-agnostic; needs no stack
 *     fields, so it is the only rule a stack declaring neither field gets.
 *  2. Comment-only differences collapse — but only per the *active stack's*
 *     declared {@link CommentSyntax}. Absent `commentSyntax` ⇒ rule 2 is a
 *     no-op, so a comment-only diff does NOT collapse for that stack.
 *  3. Reordering of lines *within a stack-declared sortable region* collapses.
 *     Empty `sortableLists` ⇒ rule 3 is a no-op.
 *
 * Stack-agnostic by construction: this module bakes in no comment token, no
 * import-block heuristic, and no per-language branch. Every ecosystem-specific
 * input — comment markers, sortable regions — arrives through the C1 stack
 * fields passed in {@link FingerprintOptions}. That delegation is the whole
 * point: `src/` is framework code that must not privilege any one ecosystem.
 *
 * Security invariant: the per-path content map is folded from caller-supplied
 * (ultimately parsed-stack-derived) keys, so it is built with the same
 * null-prototype / forbidden-key discipline as the trace reconciler — a path
 * literally named `__proto__` cannot pollute `Object.prototype` or corrupt the
 * digest.
 */

import picomatch from 'picomatch';

import { sha256Hex } from '../trace/hash.js';
import { stableStringify } from '../config-server/determinism/index.js';

// Keys that must never be copied off a caller-supplied (parsed-stack-derived)
// keyed map: they are the prototype-pollution vectors. Mirrors the
// reconcile.ts / sprint-1 / sprint-2 guard so this module's path-keyed and
// glob-keyed maps share the one established defence rather than a parallel one.
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A stack's declared comment syntax (the C1 `commentSyntax` field).
 *
 * Drives normalization rule 2: comment text matched by these markers is
 * stripped before hashing, so a comment-only edit does not change the digest.
 * Everything is optional — a stack opts in to whichever forms it has. When the
 * whole object is absent, rule 2 is a no-op.
 *
 * @property line the line-comment marker (everything from the marker to
 *   end-of-line is a comment), e.g. a stack might declare `//` or `#`. The
 *   value is the stack's, never a built-in default.
 * @property block the block-comment delimiter pair; text from `open` to the
 *   next `close` (inclusive) is a comment, possibly spanning lines.
 * @property block.open the opening delimiter the stack declares (e.g. a slash
 *   followed by an asterisk in a C-family stack).
 * @property block.close the closing delimiter the stack declares (e.g. an
 *   asterisk followed by a slash in a C-family stack).
 */
export interface CommentSyntax {
  line?: string;
  block?: { open: string; close: string };
}

/**
 * One stack-declared sortable region (an entry of the C1 `sortableLists`
 * array). Drives normalization rule 3: within a matched region, line *order*
 * is normalized away, so a reordered-but-same-lines edit does not change the
 * digest. A region the stack does not declare is left untouched.
 *
 * @property pathGlob a picomatch glob; rule 3 applies to a file only when its
 *   path matches this glob (so the region is scoped to the file kinds the
 *   stack says are sortable, e.g. its source files).
 * @property lineRangePattern a regular-expression *source* string; every
 *   contiguous run of lines whose each line matches this pattern is treated as
 *   one sortable region (e.g. a pattern matching import statements identifies
 *   an import block). Lines outside such runs keep their position.
 */
export interface SortableList {
  pathGlob: string;
  lineRangePattern: string;
}

/**
 * The normalization parameters the fingerprint reads, sourced entirely from the
 * active stack's two C1 fields. Both are optional; an absent/empty field makes
 * its rule a no-op (rule 1 always applies regardless).
 *
 * @property commentSyntax the stack's {@link CommentSyntax}; absent ⇒ rule 2 off.
 * @property sortableLists the stack's sortable regions; absent/empty ⇒ rule 3 off.
 */
export interface FingerprintOptions {
  commentSyntax?: CommentSyntax;
  sortableLists?: SortableList[];
}

/**
 * The edit set to fingerprint: the set of paths the generator touched, mapped
 * to the post-edit content of each path.
 *
 * Modelled as an array of `{ path, content }` entries rather than a plain
 * object so a path literally named `__proto__`/`constructor`/`prototype`
 * arrives as data, not as a prototype-walking key — the entries are folded into
 * a defended map inside {@link fingerprintEditSet}.
 *
 * @property path the touched file's path (used as the per-path map key).
 * @property content the file's post-edit content; opaque text, normalized per
 *   the three rules before it contributes to the digest.
 */
export interface EditFile {
  path: string;
  content: string;
}

/** An edit set: the list of touched files with their post-edit content. */
export type EditSet = EditFile[];

/**
 * Compute the normalized SHA-256 fingerprint of an edit set.
 *
 * @param editSet the touched files and their post-edit content.
 * @param options the active stack's normalization parameters
 *   ({@link FingerprintOptions}); pass `{}` (or omit fields) to get rule 1 only.
 * @returns the 64-char lowercase-hex SHA-256 digest (matches `^[0-9a-f]{64}$`).
 * @throws never for data reasons — a duplicate or forbidden-key path is folded
 *   defensively (last write wins per path; forbidden keys are still hashed as
 *   data, never installed as object keys), so a hostile edit set cannot crash
 *   the call or pollute `Object.prototype`.
 *
 * Determinism: the preimage is canonicalised — paths are sorted and each
 * file's normalized content is keyed by path via {@link stableStringify} —
 * before hashing, so the same logical edit set yields a byte-identical digest
 * regardless of the incidental order the caller listed the files in. That
 * stability is what lets sprint 4 use the digest as the oscillation-history
 * key it compares attempts against.
 */
export function fingerprintEditSet(editSet: EditSet, options: FingerprintOptions = {}): string {
  // Null-prototype accumulator + explicit forbidden-key skip: the caller's
  // paths are untrusted keys, so we never let one walk a prototype setter.
  const byPath: Record<string, string> = Object.create(null) as Record<string, string>;
  // Forbidden-key path content is still hashed (as a separate, key-safe list)
  // so it cannot be silently dropped — dropping it would let two genuinely
  // different edit sets collide just because one used a `__proto__` path.
  const forbiddenKeyed: Array<{ path: string; content: string }> = [];

  const sortable = options.sortableLists ?? [];
  const commentSyntax = options.commentSyntax;

  for (const file of editSet) {
    const normalized = normalizeFileContent(file.path, file.content, commentSyntax, sortable);
    if (FORBIDDEN_KEYS.has(file.path)) {
      forbiddenKeyed.push({ path: file.path, content: normalized });
      continue;
    }
    // Define rather than assign so even a bypass of the guard above would
    // create a real own property, not trip a `__proto__` setter.
    Object.defineProperty(byPath, file.path, {
      value: normalized,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  // Project onto a plain object with sorted paths so the preimage is canonical
  // regardless of input ordering; stableStringify then key-sorts recursively.
  const sortedPaths = Object.keys(byPath).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalFiles = sortedPaths.map((p) => ({ path: p, content: byPath[p] }));
  forbiddenKeyed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const preimage = stableStringify({
    // Domain-separation tag so this hash cannot collide with another use of
    // sha256Hex, and so the preimage format can be versioned later.
    boundary: 'editFingerprint/v1',
    files: canonicalFiles,
    forbiddenKeyedFiles: forbiddenKeyed,
  });
  return sha256Hex(preimage);
}

// Apply the three normalization rules to one file's content. Order matters and
// is deliberate: comments first (rule 2), then per-line whitespace collapse
// (rule 1) applied to each line, then reorder sortable regions (rule 3) over the
// already-whitespace-normalized lines, then drop the now-blank lines and join.
//
// Why rule 1 runs *before* rule 3 (not after): the rule-3 sort compares lines
// by value, so its sort key must be whitespace-normalized — otherwise a reorder
// that ALSO carries incidental whitespace differences inside the region (e.g.
// `import  b` vs `import b`) would sort to a different order and fail to
// collapse, even though rules 1 and 3 together make the two edit sets logically
// identical. Normalizing each line first makes both the region-match and the
// sort key whitespace-insensitive, so reorder-plus-whitespace collapses too. A
// rule whose field is absent/empty is a structural no-op, not a special case.
function normalizeFileContent(
  filePath: string,
  content: string,
  commentSyntax: CommentSyntax | undefined,
  sortable: readonly SortableList[],
): string {
  // Rule 2: strip comments per the stack-declared syntax. Skipped entirely
  // when the stack declares no commentSyntax, which is why a comment-only diff
  // does not collapse for such a stack — the markers come from the field, not
  // a built-in default.
  const decommented = commentSyntax ? stripComments(content, commentSyntax) : content;

  // Rule 1: collapse each line's whitespace up front — trim it and squeeze
  // internal whitespace runs to a single space — so indentation, trailing
  // whitespace, and line-ending style wash out before the rule-3 sort uses the
  // line as a comparison key. Blank lines become '' here and are dropped after
  // the sort (a '' line never matches a sortable region's pattern, so its
  // position is irrelevant).
  let lines = splitLines(decommented).map((l) => l.replace(/\s+/g, ' ').trim());

  // Rule 3: within each region this file's path opts into, sort the contiguous
  // runs of region-matching lines over the whitespace-normalized lines above.
  // Scoped to the declared region (pathGlob + lineRangePattern) so reordering
  // OUTSIDE it still changes the digest.
  for (const region of sortable) {
    if (!FORBIDDEN_KEYS.has(region.pathGlob) && pathMatchesGlob(filePath, region.pathGlob)) {
      lines = sortMatchingRuns(lines, region.lineRangePattern);
    }
  }

  // Drop the blank lines rule 1 produced and join; the per-line whitespace
  // collapse already ran above, so this is purely the blank-line filter.
  return lines.filter((l) => l.length > 0).join('\n');
}

// Split on any line-ending style (CRLF, CR, LF) so line-ending differences are
// already neutral before rule 1 runs. Returns the content's lines.
function splitLines(content: string): string[] {
  return content.split(/\r\n|\r|\n/);
}

// Match a single path against one glob, reusing the project's picomatch config
// (dot: true) so dotfile paths match as they do elsewhere. A non-compilable
// glob from a malformed stack field is treated as "matches nothing" rather than
// throwing, so one bad region cannot abort a whole fingerprint.
function pathMatchesGlob(filePath: string, pattern: string): boolean {
  try {
    return picomatch(pattern, { dot: true })(filePath);
  } catch {
    return false;
  }
}

// String-literal delimiters the comment scanner treats as opaque: a comment
// marker that appears between matching delimiters is string content, not a
// comment, and must not be stripped. Covers the single/double/backtick quotes
// common across mainstream ecosystems. This is a best-effort heuristic, not a
// full per-language lexer — A1 defers deeper cross-language support to the
// stack-declared fields — but it eliminates the realistic false collapse where
// a stack's comment marker appears inside a string (e.g. `//` inside a URL
// string literal), which would otherwise erase a real in-string difference and
// make two genuinely-different edits hash identically.
const STRING_DELIMITERS: ReadonlySet<string> = new Set(['"', "'", '`']);

// Strip comment text per the stack-declared syntax, scanning character by
// character so a comment marker INSIDE a string literal is preserved. The
// scanner tracks three exclusive states — string, block comment, line comment —
// and only recognises a comment marker in normal (non-string) text:
//
//  - String: from an opening quote to the matching close quote (honouring
//    backslash escapes), copied verbatim; an unterminated string copies to EOF.
//  - Block comment: from the open delimiter to the next close (inclusive),
//    removed entirely including any internal newlines; an unterminated open is
//    treated as a comment to end-of-content.
//  - Line comment: from the marker to (not including) the end of line, so the
//    newline survives and a marker on one line never eats the next.
//
// Markers are arbitrary literal strings, matched verbatim with startsWith (not
// as regexes). When the stack declares neither marker the content is returned
// unchanged. Block is checked before line so a `/* */` stack whose line marker
// shares a prefix is classified correctly.
function stripComments(content: string, syntax: CommentSyntax): string {
  const lineMarker = syntax.line && syntax.line.length > 0 ? syntax.line : undefined;
  const blockOpen =
    syntax.block && syntax.block.open.length > 0 && syntax.block.close.length > 0
      ? syntax.block.open
      : undefined;
  const blockClose = blockOpen ? syntax.block!.close : undefined;
  if (lineMarker === undefined && blockOpen === undefined) return content;

  let out = '';
  let i = 0;
  const n = content.length;

  while (i < n) {
    const ch = content[i];

    // String literal: copy verbatim to the matching close quote so a comment
    // marker between the quotes is never treated as a comment.
    if (STRING_DELIMITERS.has(ch)) {
      out += ch;
      i++;
      while (i < n) {
        const c = content[i];
        out += c;
        i++;
        if (c === '\\' && i < n) {
          // Escaped character: copy the escapee verbatim so an escaped quote
          // (e.g. \") does not prematurely close the string.
          out += content[i];
          i++;
          continue;
        }
        if (c === ch) break; // matching close quote ends the string
      }
      continue;
    }

    // Block comment: open delimiter to the next close (inclusive), removed
    // whole. Checked before the line marker.
    if (blockOpen !== undefined && content.startsWith(blockOpen, i)) {
      const closeAt = content.indexOf(blockClose as string, i + blockOpen.length);
      i = closeAt === -1 ? n : closeAt + (blockClose as string).length;
      continue;
    }

    // Line comment: marker to end-of-line, leaving the line terminator.
    if (lineMarker !== undefined && content.startsWith(lineMarker, i)) {
      let j = i + lineMarker.length;
      while (j < n && content[j] !== '\n' && content[j] !== '\r') j++;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

// Sort each maximal contiguous run of lines that match `patternSource`,
// in place within the array, leaving non-matching lines (and their positions)
// untouched. This is rule 3's core: order within a declared sortable region is
// normalized, order elsewhere is preserved.
function sortMatchingRuns(lines: string[], patternSource: string): string[] {
  let matcher: RegExp;
  try {
    matcher = new RegExp(patternSource);
  } catch {
    // A malformed lineRangePattern matches nothing; the region is then a no-op
    // rather than a crash (defensive against a bad stack field).
    return lines;
  }

  const out: string[] = [];
  let run: string[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      // Locale-independent byte order so the normalized order is identical on
      // every host, which is required for a stable digest.
      run.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out.push(...run);
      run = [];
    }
  };

  for (const l of lines) {
    if (matcher.test(l)) {
      run.push(l);
    } else {
      flushRun();
      out.push(l);
    }
  }
  flushRun();
  return out;
}
