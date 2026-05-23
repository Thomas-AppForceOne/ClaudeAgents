/**
 * Decide which stacks are *active* for a project.
 *
 * Two mutually-exclusive modes:
 * 1. Explicit override — when the cascaded overlay supplies a non-empty
 *    `stack.override`, that list is authoritative: auto-detection is skipped
 *    entirely, and each named stack must exist (a missing one is an issue).
 * 2. Auto-detection — otherwise each built-in stack's `detection` block is
 *    evaluated against the project's files; a stack whose detection matches
 *    becomes active.
 *
 * A guaranteed fallback: if auto-detection matches nothing and a `generic`
 * stack exists, `generic` is activated so a project is never left with zero
 * stacks. Results are always {@link localeSort}ed for deterministic output.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { glob, localeSort } from '../determinism/index.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

/**
 * Detection inputs drawn from the cascaded overlay.
 *
 * @property stackOverride the merged `stack.override` list. When present and
 *   non-empty it forces explicit mode (auto-detection is bypassed). Empty or
 *   absent ⇒ auto-detection.
 */
export interface DetectionInputOverlay {

  stackOverride?: string[];
}

/**
 * Detection outcome.
 *
 * @property active the active stack names, locale-sorted and de-duplicated.
 * @property issues problems found while detecting — an overridden stack that
 *   does not exist (`MissingFile`), or a stack declaring an uninterpretable
 *   glob (`MalformedInput`).
 */
export interface DetectionResult {

  active: string[];

  issues: Issue[];
}

/**
 * Compute the active stacks for the project described by `snapshot`.
 *
 * @param snapshot the phase-1 validation snapshot, providing the stack files
 *   (with parsed data) and the project root.
 * @param overlay cascaded overlay inputs; see {@link DetectionInputOverlay}.
 * @returns a {@link DetectionResult}. Never throws — filesystem and glob
 *   failures degrade to "no match" or are reported as issues.
 *
 * In override mode, blank/duplicate names are skipped and each remaining name
 * is checked for existence. In auto-detection mode, only `builtin`-tier stacks
 * are considered (a project/user override of an existing built-in is still
 * keyed by the built-in's name); the first matching detection entry activates
 * a stack, but a *malformed* glob in any entry disqualifies that whole stack
 * and raises an issue.
 */
export function detectActiveStacks(
  snapshot: ValidationSnapshot,
  overlay: DetectionInputOverlay = {},
): DetectionResult {
  const issues: Issue[] = [];
  const stackFilesByName = indexBuiltinStacksByName(snapshot);

  const override = overlay.stackOverride ?? [];

  // Mode 1: an explicit, non-empty override fully replaces auto-detection.
  if (override.length > 0) {

    const active: string[] = [];
    const seen = new Set<string>();
    for (const name of override) {
      // Skip blanks and duplicates so the override list is tolerant of user
      // formatting without producing repeated active entries.
      if (typeof name !== 'string' || name.length === 0) continue;
      if (seen.has(name)) continue;
      seen.add(name);

      if (!stackExists(snapshot, name)) {
        issues.push({
          code: 'MissingFile',
          field: '/stack/override',
          message:
            `Cascaded stack.override references stack '${name}' but no stack file ` +
            `with that name exists in any tier. Create the stack file at ` +
            `.claude/gan/stacks/${name}.md or remove the override entry.`,
          severity: 'error',
        });
        continue;
      }
      active.push(name);
    }
    return { active: localeSort(active), issues };
  }

  // Mode 2: auto-detection. Enumerate the project's files once, then test each
  // built-in stack's detection block against that one candidate set.
  const candidateFiles = enumerateProjectFiles(snapshot.projectRoot);
  const matched = new Set<string>();

  for (const [name, row] of stackFilesByName.entries()) {
    if (!row.data) continue;
    const detection = readDetectionBlock(row.data);
    if (detection === null) continue;
    if (detection.length === 0) continue;
    // A stack's detection entries are OR-ed: the first matching entry activates
    // it. A malformed glob anywhere, however, disqualifies the whole stack and
    // is reported — a broken pattern must not silently half-match.
    let stackMatches = false;
    for (const entry of detection) {
      const result = evaluateDetectionEntry(entry, candidateFiles, snapshot.projectRoot);
      if (result.malformed) {
        issues.push({
          code: 'MalformedInput',
          path: row.path,
          field: '/detection',
          message:
            `Stack file '${row.path}' declares an invalid detection pattern ` +
            `(${result.malformedPattern}). The framework cannot interpret this glob. ` +
            `Edit the stack file's detection block so every pattern is a valid glob.`,
          severity: 'error',
        });
        // Force non-activation regardless of any earlier matching entry.
        stackMatches = false;
        break;
      }
      if (result.matched) {
        stackMatches = true;
        // Short-circuit: one match is enough to activate (OR semantics).
        break;
      }
    }
    if (stackMatches) matched.add(name);
  }

  // Safety net: never leave a project with no active stack. `generic` is the
  // catch-all when nothing else detected.
  if (matched.size === 0 && stackExists(snapshot, 'generic')) {
    matched.add('generic');
  }

  return { active: localeSort(Array.from(matched)), issues };
}

// Build a name → row map of the BUILTIN-tier stack files only, in locale order
// so the "first wins per name" choice is deterministic. Auto-detection keys off
// built-in stacks (project/user overrides are resolved later by name), so
// non-builtin rows are skipped here.
function indexBuiltinStacksByName(snapshot: ValidationSnapshot): Map<string, SnapshotStackRow> {
  const out = new Map<string, SnapshotStackRow>();
  const keys = localeSort(Array.from(snapshot.stackFiles.keys()));
  for (const key of keys) {
    const row = snapshot.stackFiles.get(key);
    if (!row) continue;
    if (row.tier !== 'builtin') continue;
    const name = stackNameFromPath(row.path);
    if (!name) continue;
    if (!out.has(name)) out.set(name, row);
  }
  return out;
}

// True when any stack file (any tier) resolves to the given name. Used both to
// validate override entries and to check for the `generic` fallback.
function stackExists(snapshot: ValidationSnapshot, name: string): boolean {
  for (const row of snapshot.stackFiles.values()) {
    if (stackNameFromPath(row.path) === name) return true;
  }
  return false;
}

// Derive a stack's name from its file path (basename minus the `.md`
// extension). Returns null for a non-`.md` path so callers can skip it.
function stackNameFromPath(p: string): string | null {
  const base = path.basename(p);
  if (!base.endsWith('.md')) return null;
  return base.slice(0, -'.md'.length);
}

// Outcome of evaluating one detection entry. `malformed` takes priority over
// `matched` in the caller: a malformed entry disqualifies the stack regardless
// of other matches, and `malformedPattern` carries the offending glob for the
// error message.
interface DetectionEvalResult {
  matched: boolean;
  malformed: boolean;
  malformedPattern?: string;
}

// Evaluate a single detection entry against the project's files. Entries take
// four shapes, evaluated recursively:
//   - a bare glob string → matches if any candidate file matches it;
//   - `{ allOf: [...] }`  → matches only if every child matches (AND);
//   - `{ anyOf: [...] }`  → matches if any child matches (OR);
//   - `{ path, contains }` → reads the file at `path` and matches if its text
//     contains any listed needle (content probe, not a glob).
// Any unrecognised shape is a non-match. A glob that picomatch cannot compile
// surfaces as `malformed`; all filesystem errors (missing file, unreadable,
// not-a-file) degrade to a quiet non-match — only an uninterpretable *pattern*
// is treated as user error.
function evaluateDetectionEntry(
  entry: unknown,
  candidateFiles: string[],
  projectRoot: string,
): DetectionEvalResult {
  if (typeof entry === 'string') {
    let matches: string[];
    try {
      matches = glob(entry, candidateFiles);
    } catch {
      return { matched: false, malformed: true, malformedPattern: entry };
    }
    return { matched: matches.length > 0, malformed: false };
  }
  if (isObject(entry)) {
    if ('allOf' in entry && Array.isArray(entry.allOf)) {
      for (const child of entry.allOf) {
        const r = evaluateDetectionEntry(child, candidateFiles, projectRoot);
        if (r.malformed) return r;
        if (!r.matched) return { matched: false, malformed: false };
      }
      // An empty allOf is treated as a non-match (vacuous truth would
      // activate every stack carrying one, which is never intended).
      return { matched: entry.allOf.length > 0, malformed: false };
    }
    if ('anyOf' in entry && Array.isArray(entry.anyOf)) {
      for (const child of entry.anyOf) {
        const r = evaluateDetectionEntry(child, candidateFiles, projectRoot);
        if (r.malformed) return r;
        if (r.matched) return { matched: true, malformed: false };
      }
      return { matched: false, malformed: false };
    }
    if (typeof entry.path === 'string' && Array.isArray(entry.contains)) {
      // Content probe: resolve `path` (relative to project root unless already
      // absolute) and match if the file's text contains any needle.
      const target = path.isAbsolute(entry.path) ? entry.path : path.join(projectRoot, entry.path);
      if (!existsSync(target)) return { matched: false, malformed: false };
      let stats;
      try {
        stats = statSync(target);
      } catch {
        return { matched: false, malformed: false };
      }
      if (!stats.isFile()) return { matched: false, malformed: false };
      let text: string;
      try {
        text = readFileSync(target, 'utf8');
      } catch {
        return { matched: false, malformed: false };
      }
      for (const needle of entry.contains) {
        if (typeof needle === 'string' && text.includes(needle)) {
          return { matched: true, malformed: false };
        }
      }
      return { matched: false, malformed: false };
    }
  }
  return { matched: false, malformed: false };
}

// Extract a stack's `detection` array, or null when the data is not an object
// or has no array-valued `detection` key (the stack then opts out of
// auto-detection).
function readDetectionBlock(data: unknown): unknown[] | null {
  if (!isObject(data)) return null;
  const det = data['detection'];
  if (!Array.isArray(det)) return null;
  return det;
}

// Recursively list the project's files as project-relative, `/`-separated
// paths suitable for globbing. Implemented as an explicit stack (not
// recursion) to avoid call-stack limits on deep trees. Heavy/irrelevant
// directories (.git, node_modules, build outputs, gan state/cache) are pruned
// so detection is fast and not skewed by generated files. Per-entry I/O errors
// are skipped so an unreadable subtree does not abort enumeration. Output is
// locale-sorted for deterministic glob results.
function enumerateProjectFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const stack: string[] = [projectRoot];
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.gan-state', '.gan-cache']);
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        if (skipDirs.has(name)) continue;
        stack.push(full);
      } else if (s.isFile()) {
        const rel = path.relative(projectRoot, full);
        // Normalise to forward slashes so globs are platform-independent.
        out.push(rel.split(path.sep).join('/'));
      }
    }
  }
  return localeSort(out);
}

// Local plain-object guard: true only for a non-null, non-array object.
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
