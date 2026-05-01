/**
 * R1 sprint 5 — C2 stack detection and dispatch.
 *
 * Resolves the active set of stacks for a project, given:
 *   1. The discovery snapshot (`stackFiles`) from validateAll's phase 1;
 *   2. The cascaded overlay's `stack.override` (post-C4 cascade);
 *   3. The project root (used to materialise file paths for glob matching).
 *
 * Algorithm (per C2 + project-context "dispatch invariants"):
 *   - If `stack.override` is non-empty after cascade → use exactly that
 *     list. Auto-detection is **skipped**. Each named stack must exist
 *     somewhere in the snapshot's stackFiles or `MissingFile` issues.
 *   - If `stack.override` is empty after cascade → run auto-detection on
 *     every built-in (tier-3) stack file's `detection` block. Active set
 *     is the **union** of every stack whose detection rules match.
 *   - If auto-detection matches zero stacks → activate the `generic`
 *     stack as a conservative fallback (per C2, only if a stack named
 *     `generic` is present in the snapshot — fixtures that don't ship one
 *     produce an empty active set, surfaced as a structured note in the
 *     resolved config rather than an error).
 *
 * Determinism:
 *   - Glob match via `determinism.glob` (picomatch v4 pinned).
 *   - Active set is sorted via `localeSort` before return.
 *   - Project files are enumerated lazily; the enumeration is sorted.
 *
 * Failure modes (per C2 "Error model" section):
 *   - Malformed glob in a `detection` block → `MalformedInput` issue.
 *     Dispatch fails closed: the offending stack is not activated.
 *   - Overlay's `stack.override` references a stack with no matching file
 *     → `MissingFile` issue (the same shape S4's discovery layer
 *     produces; we keep that layer as the canonical source for
 *     stack-resolution issues).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { glob, localeSort } from '../determinism/index.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

/** Subset of cascaded overlay relevant to detection dispatch. */
export interface DetectionInputOverlay {
  /**
   * Resolved value of `stack.override` after the C4 cascade. Empty array
   * (or `undefined`) means "run auto-detection".
   */
  stackOverride?: string[];
}

/** Return shape of `detectActiveStacks`. */
export interface DetectionResult {
  /** Sorted list of active stack names (deterministic). */
  active: string[];
  /** Issues collected during detection (malformed globs, missing stacks). */
  issues: Issue[];
}

/**
 * Resolve the active stack set for a project.
 *
 * The snapshot is the post-discovery view: `stackFiles` carries every
 * known stack file at every tier; `projectRoot` is canonicalised. The
 * caller (typically `composeResolvedConfig`) supplies the cascaded
 * overlay's `stack.override` so dispatch operates on the *resolved*
 * value, not on any single tier's raw value.
 */
export function detectActiveStacks(
  snapshot: ValidationSnapshot,
  overlay: DetectionInputOverlay = {},
): DetectionResult {
  const issues: Issue[] = [];
  const stackFilesByName = indexBuiltinStacksByName(snapshot);

  const override = overlay.stackOverride ?? [];

  if (override.length > 0) {
    // All-or-nothing: skip auto-detection, use exactly the named list.
    const active: string[] = [];
    const seen = new Set<string>();
    for (const name of override) {
      if (typeof name !== 'string' || name.length === 0) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      // The S4 discovery layer already raises `MissingFile` for unknown
      // override names against the project overlay; we double-check here
      // because the cascaded view may differ from any single tier. We
      // only emit a fresh issue if the discovery layer didn't already
      // catch it — checking `stackExists` against the snapshot is enough.
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

  // No override after cascade → run auto-detection.
  const candidateFiles = enumerateProjectFiles(snapshot.projectRoot);
  const matched = new Set<string>();

  for (const [name, row] of stackFilesByName.entries()) {
    if (!row.data) continue;
    const detection = readDetectionBlock(row.data);
    if (detection === null) continue;
    if (detection.length === 0) continue; // generic-style stack, only via fallback
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
        // Failed-closed: skip the rest of this stack's detection rules.
        stackMatches = false;
        break;
      }
      if (result.matched) {
        stackMatches = true;
        // Continue evaluating siblings? No — `detection` is a top-level
        // OR (per C1: each entry is independent; matching any one
        // activates the stack). Short-circuit on first match.
        break;
      }
    }
    if (stackMatches) matched.add(name);
  }

  // Generic fallback: when auto-detection matches nothing, activate the
  // `generic` stack if it exists in the snapshot.
  if (matched.size === 0 && stackExists(snapshot, 'generic')) {
    matched.add('generic');
  }

  return { active: localeSort(Array.from(matched)), issues };
}

/**
 * Build a name → row map limited to **built-in** (tier-3) stack rows,
 * which are the only tier where `detection` may live (per C5 / the
 * detection.tier3_only invariant). Project- and user-tier rows still
 * shadow the built-in for *content*, but detection always reads from
 * tier 3. We index by name so callers see the single canonical source.
 */
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

function stackExists(snapshot: ValidationSnapshot, name: string): boolean {
  for (const row of snapshot.stackFiles.values()) {
    if (stackNameFromPath(row.path) === name) return true;
  }
  return false;
}

function stackNameFromPath(p: string): string | null {
  const base = path.basename(p);
  if (!base.endsWith('.md')) return null;
  return base.slice(0, -'.md'.length);
}

interface DetectionEvalResult {
  matched: boolean;
  malformed: boolean;
  malformedPattern?: string;
}

/**
 * Evaluate a single detection entry per C1's grammar:
 *
 *   - bare string  → glob, matched against project files
 *   - `{path, contains: [...]}` → file at `path` exists and its contents
 *     contain at least one of the `contains` substrings
 *   - `{allOf: [...]}` → every nested entry matches
 *   - `{anyOf: [...]}` → at least one nested entry matches
 *
 * Returns `{matched, malformed}`. A malformed glob short-circuits the
 * walk and propagates upward.
 */
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
      // `contains` is a content check rather than a glob. Look up the
      // single named file relative to the project root and grep for any
      // of the substrings.
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

function readDetectionBlock(data: unknown): unknown[] | null {
  if (!isObject(data)) return null;
  const det = data['detection'];
  if (!Array.isArray(det)) return null;
  return det;
}

/**
 * Enumerate every file underneath `projectRoot`, returning project-relative
 * paths suitable for glob matching. Excludes well-known noisy directories
 * (`.git`, `node_modules`, `dist`, `.gan-state`, `.gan-cache`) so detection
 * runs in linear time on real-world repos.
 *
 * Output is sorted via `localeSort`; the per-file order shouldn't matter
 * for `glob` semantics but we keep the deterministic output anyway.
 */
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
        // Normalise to forward slashes so picomatch globs (which are POSIX)
        // match consistently on Windows. picomatch tolerates either, but
        // we want deterministic output.
        out.push(rel.split(path.sep).join('/'));
      }
    }
  }
  return localeSort(out);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
