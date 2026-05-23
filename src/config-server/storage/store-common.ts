

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StoreEnv {

  homedir?: () => string;

  env?: NodeJS.ProcessEnv;
}

export function resolveHomedir(deps?: StoreEnv): string {
  return (deps?.homedir ?? os.homedir)();
}

export function resolveEnv(deps?: StoreEnv): NodeJS.ProcessEnv {
  return deps?.env ?? process.env;
}

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

export interface StoreRootSpec {

  envVar: string;

  markerRelpath: string;

  defaultDirname: string;
}

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
