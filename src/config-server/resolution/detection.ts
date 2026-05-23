

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { glob, localeSort } from '../determinism/index.js';
import type { Issue } from '../validation/schema-check.js';
import type { SnapshotStackRow, ValidationSnapshot } from '../tools/validate.js';

export interface DetectionInputOverlay {

  stackOverride?: string[];
}

export interface DetectionResult {

  active: string[];

  issues: Issue[];
}

export function detectActiveStacks(
  snapshot: ValidationSnapshot,
  overlay: DetectionInputOverlay = {},
): DetectionResult {
  const issues: Issue[] = [];
  const stackFilesByName = indexBuiltinStacksByName(snapshot);

  const override = overlay.stackOverride ?? [];

  if (override.length > 0) {

    const active: string[] = [];
    const seen = new Set<string>();
    for (const name of override) {
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

  const candidateFiles = enumerateProjectFiles(snapshot.projectRoot);
  const matched = new Set<string>();

  for (const [name, row] of stackFilesByName.entries()) {
    if (!row.data) continue;
    const detection = readDetectionBlock(row.data);
    if (detection === null) continue;
    if (detection.length === 0) continue;
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

        stackMatches = false;
        break;
      }
      if (result.matched) {
        stackMatches = true;

        break;
      }
    }
    if (stackMatches) matched.add(name);
  }

  if (matched.size === 0 && stackExists(snapshot, 'generic')) {
    matched.add('generic');
  }

  return { active: localeSort(Array.from(matched)), issues };
}

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

        out.push(rel.split(path.sep).join('/'));
      }
    }
  }
  return localeSort(out);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
