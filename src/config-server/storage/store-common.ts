/**
 * Shared store-root resolution primitives for the central, repo-keyed stores.
 *
 * F7's run-data store (`run-store.ts`) and F8's module-state store
 * (`module-state-store.ts`) resolve their roots by the SAME ladder —
 * env override → install-time marker → default dir under home — with the
 * SAME tilde/relative absolutization and the SAME empty-value fall-through.
 * Those primitives live here, in ONE implementation, so the two stores share
 * the behaviour rather than each carrying a near-identical copy (PROJECT_CONTEXT
 * reuse-don't-duplicate). Each store supplies only what genuinely differs: its
 * env-var name, marker relpath, and default dirname.
 *
 * Determinism / safety: this module does no subprocess work and no path
 * canonicalisation; case-folding lives in the determinism module and git lives
 * in `git-exec.ts`. It only expands `~`/relative paths against the home dir.
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Optional dependency seam so tests can isolate `os.homedir` / `process.env`.
 * Shared by every central store so the home/env injection style is identical
 * across `run-store` and `module-state-store`.
 */
export interface StoreEnv {
  /** Defaults to `os.homedir()`. */
  homedir?: () => string;
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/** Resolve the home directory through the seam (defaults to `os.homedir`). */
export function resolveHomedir(deps?: StoreEnv): string {
  return (deps?.homedir ?? os.homedir)();
}

/** Resolve the environment through the seam (defaults to `process.env`). */
export function resolveEnv(deps?: StoreEnv): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

/**
 * Expand a configured store path to an absolute form. A leading `~` is expanded
 * to the home directory (never left as a literal `~`); a relative path is
 * resolved against the home directory; an absolute path is normalised.
 */
export function absolutize(p: string, home: string): string {
  let expanded = p;
  if (expanded === '~') {
    expanded = home;
  } else if (expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = path.join(home, expanded.slice(2));
  }
  if (path.isAbsolute(expanded)) {
    return path.normalize(expanded);
  }
  return path.resolve(home, expanded);
}

/**
 * Read an install-time marker file's contents, or `undefined` if it is absent
 * or empty after trimming. The marker's single line is the configured
 * store-root path. Trailing whitespace/newline is stripped; an all-whitespace
 * marker is treated as absent.
 *
 * @param markerRelpath path of the marker relative to the user's home dir.
 */
export function readStoreMarker(markerRelpath: string, deps?: StoreEnv): string | undefined {
  const markerPath = path.join(resolveHomedir(deps), markerRelpath);
  if (!existsSync(markerPath)) return undefined;
  try {
    const contents = readFileSync(markerPath, 'utf8').trim();
    return contents.length > 0 ? contents : undefined;
  } catch {
    return undefined;
  }
}

/** The differing knobs each central store supplies to the shared ladder. */
export interface StoreRootSpec {
  /** Environment variable that overrides the store root (highest precedence). */
  envVar: string;
  /** Install-time marker relpath under home (middle precedence). */
  markerRelpath: string;
  /** Default directory name under home (lowest precedence). */
  defaultDirname: string;
}

/**
 * Resolve a store root by the shared precedence ladder, highest first:
 *   1. The `spec.envVar` environment variable, when non-empty after trimming
 *      (an empty/whitespace value is treated as absent and falls through).
 *   2. The path recorded in the install-time marker at `spec.markerRelpath`.
 *   3. Default `<home>/<spec.defaultDirname>`.
 *
 * The returned path is always absolute with the home directory expanded — never
 * a literal `~`. The env and marker forms are absolutized (relative to home if
 * not already absolute); the default form joins `os.homedir()`.
 */
export function resolveStoreRootByPrecedence(spec: StoreRootSpec, deps?: StoreEnv): string {
  const home = resolveHomedir(deps);
  const env = resolveEnv(deps);

  const fromEnv = env[spec.envVar];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return absolutize(fromEnv.trim(), home);
  }

  const fromMarker = readStoreMarker(spec.markerRelpath, deps);
  if (fromMarker !== undefined) {
    return absolutize(fromMarker, home);
  }

  return path.join(home, spec.defaultDirname);
}
