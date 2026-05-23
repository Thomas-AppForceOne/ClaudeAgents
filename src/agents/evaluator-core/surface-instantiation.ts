

import picomatch from 'picomatch';

interface SurfaceLike {
  id: string;
  template: string;
  triggers?: {
    keywords?: string[];
    scope?: string[];
  };
}

export interface InstantiatedSurfaceRow {

  stack: string;

  id: string;

  templateText: string;

  triggerEvidence: { scopeMatched: string[]; keywordsHit: string[] };

  appliesToFiles: string[];
}

export interface StackSurfaceInput {
  name: string;
  scope: readonly string[];
  surfaces: readonly SurfaceLike[];
}

export function instantiateSurfaces(
  stacks: readonly StackSurfaceInput[],
  affectedFiles: readonly string[],
  fileContents: Record<string, string>,
): InstantiatedSurfaceRow[] {
  const rows: InstantiatedSurfaceRow[] = [];

  for (const stack of stacks) {
    if (stack.surfaces.length === 0) continue;

    const stackScopedTouched = filterByGlobs(affectedFiles, stack.scope);

    for (const surface of stack.surfaces) {
      const instantiated = instantiateSurface(
        stack.name,
        surface,
        stackScopedTouched,
        fileContents,
      );
      if (instantiated !== null) rows.push(instantiated);
    }
  }

  rows.sort((a, b) => {
    const byStack = a.stack.localeCompare(b.stack, undefined, {
      sensitivity: 'variant',
      numeric: false,
    });
    if (byStack !== 0) return byStack;
    return a.id.localeCompare(b.id, undefined, {
      sensitivity: 'variant',
      numeric: false,
    });
  });
  return rows;
}

function instantiateSurface(
  stackName: string,
  surface: SurfaceLike,
  stackScopedTouched: readonly string[],
  fileContents: Record<string, string>,
): InstantiatedSurfaceRow | null {
  const triggers = surface.triggers ?? {};
  const triggerScope = triggers.scope ?? [];
  const triggerKeywords = triggers.keywords ?? [];

  let candidateFiles: readonly string[];
  if (triggerScope.length > 0) {
    candidateFiles = filterByGlobs(stackScopedTouched, triggerScope);
    if (candidateFiles.length === 0) return null;
  } else {

    candidateFiles = stackScopedTouched;
  }

  if (triggerScope.length === 0 && triggerKeywords.length === 0) {
    if (stackScopedTouched.length === 0) return null;
  }

  let keywordsHit: string[] = [];
  let scopeMatched: string[];
  if (triggerKeywords.length > 0) {
    const matched: { file: string; keyword: string }[] = [];
    for (const file of candidateFiles) {
      const content = fileContents[file];
      if (typeof content !== 'string') continue;
      for (const kw of triggerKeywords) {
        if (kw.length > 0 && content.includes(kw)) {
          matched.push({ file, keyword: kw });
        }
      }
    }
    if (matched.length === 0) return null;
    const fileSet = new Set<string>();
    const keywordSet = new Set<string>();
    for (const m of matched) {
      fileSet.add(m.file);
      keywordSet.add(m.keyword);
    }
    scopeMatched = localeSort(Array.from(fileSet));
    keywordsHit = localeSort(Array.from(keywordSet));
  } else {
    scopeMatched = localeSort([...candidateFiles]);
  }

  return {
    stack: stackName,
    id: surface.id,

    templateText: surface.template,
    triggerEvidence: { scopeMatched, keywordsHit },
    appliesToFiles: scopeMatched.slice(),
  };
}

function filterByGlobs(candidates: readonly string[], patterns: readonly string[]): string[] {
  if (patterns.length === 0) return [];
  const matched: string[] = [];
  for (const c of candidates) {
    for (const pattern of patterns) {

      const isMatch = picomatch(pattern, { dot: true });
      if (isMatch(c)) {
        matched.push(c);
        break;
      }
    }
  }
  return localeSort(matched);
}

function localeSort(items: readonly string[]): string[] {
  const copy = items.slice();

  copy.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'variant', numeric: false }),
  );
  return copy;
}
