

/**
 * Shared store-root resolution used by both the run store and the module-state
 * store.
 *
 * Each store decides its on-disk root by a single, consistent precedence
 * ({@link resolveStoreRootByPrecedence}): an explicit environment variable, then
 * a marker file under the user's home pointing at a directory, then a default
 * directory under home. Centralising it here keeps the two stores' behaviour
 * identical and makes the home/env dependencies injectable ({@link StoreEnv})
 * for hermetic tests.
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Injectable environment seams for store resolution.
 *
 * @property homedir override for the user's home-directory lookup; defaults to
 *   `os.homedir`.
 * @property env override for the process environment; defaults to `process.env`.
 */
export interface StoreEnv {

  homedir?: () => string;

  env?: NodeJS.ProcessEnv;
}

/** Resolve the user's home directory, honouring an injected `homedir` seam. */
export function resolveHomedir(deps?: StoreEnv): string {
  return (deps?.homedir ?? os.homedir)();
}

/** Resolve the process environment, honouring an injected `env` seam. */
export function resolveEnv(deps?: StoreEnv): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

/**
 * Turn a configured path into an absolute, normalised one, expanding a leading
 * `~`.
 *
 * @param p the configured path; may be `~`, `~/...` (or `~\\...` on Windows), an
 *   absolute path, or a relative path.
 * @param home the home directory `~` expands to, and the base relative paths
 *   resolve against.
 * @returns the absolute normalised path. A relative `p` is resolved relative to
 *   `home` (not cwd) so store locations are stable regardless of where the
 *   process was launched.
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
 * Read a store marker file (under home) whose contents redirect a store root.
 *
 * @param markerRelpath the marker path relative to home.
 * @param deps environment seams.
 * @returns the trimmed marker contents, or `undefined` when the marker is
 *   absent, unreadable, or empty/whitespace-only. Never throws.
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

/**
 * The three inputs that distinguish one store's root resolution from another.
 *
 * @property envVar the environment variable consulted first.
 * @property markerRelpath the home-relative marker file consulted second.
 * @property defaultDirname the directory under home used as the fallback.
 */
export interface StoreRootSpec {

  envVar: string;

  markerRelpath: string;

  defaultDirname: string;
}

/**
 * Resolve a store root by precedence: env var → marker file → home default.
 *
 * The env var wins only when set to a non-blank value; an empty/whitespace env
 * var is treated as unset and falls through to the marker, so an accidentally
 * blank export does not silently relocate the store to home root. Both the env
 * value and the marker value are run through {@link absolutize} (so `~` and
 * relative forms work); the default is joined under home directly.
 *
 * @param spec the store's {@link StoreRootSpec}.
 * @param deps environment seams.
 * @returns the absolute store root directory. Never throws.
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
