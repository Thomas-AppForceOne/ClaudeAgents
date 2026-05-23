

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import AjvImport2020, { type ValidateFunction } from 'ajv/dist/2020.js';

import { localeSort } from '../determinism/index.js';
import { ConfigServerError, createError } from '../errors.js';
import { packageRoot as resolvePackageRoot } from '../package-root.js';
import { moduleManifestV1 } from '../schemas-bundled.js';
import {
  type ModuleStateStoreOptions,
  resolveModuleRepoKey,
  resolveModuleStatePath,
  resolveModuleStateRoot,
  resolveRepoModuleStateDir,
} from './module-state-store.js';

type AjvCtor = new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv2020: AjvCtor =
  ((AjvImport2020 as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport2020 as unknown as AjvCtor);

let manifestValidator: ValidateFunction | null = null;
function getManifestValidator(): ValidateFunction {
  if (manifestValidator !== null) return manifestValidator;
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
  manifestValidator = ajv.compile(moduleManifestV1);
  return manifestValidator;
}

export interface ModuleManifest {
  name: string;
  schemaVersion: 1;
  description: string;
  exports: string[];
  pairsWith?: string;
  prerequisites?: Array<{ command: string; errorHint: string }>;
  stateKeys?: string[];
  configKey?: string;
}

export interface ModuleRegistration {
  name: string;
  manifestPath: string;
  manifest: ModuleManifest;
}

export interface ModuleStateRecord {
  name: string;
  state: unknown;
}

export function defaultModulesRoot(): string {
  return path.join(resolvePackageRoot(), 'src', 'modules');
}

export function loadModules(modulesRoot: string): ModuleRegistration[] {
  if (!existsSync(modulesRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(modulesRoot);
  } catch {
    return [];
  }

  const registrations: ModuleRegistration[] = [];
  const sortedEntries = localeSort(entries);

  for (const entry of sortedEntries) {
    const dirPath = path.join(modulesRoot, entry);
    let st;
    try {
      st = statSync(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const manifestPath = path.join(dirPath, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = readAndValidateManifest(manifestPath);
    runPrerequisites(manifest, manifestPath);
    registrations.push({ name: manifest.name, manifestPath, manifest });
  }

  detectCollisions(registrations);

  registrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return registrations;
}

function readAndValidateManifest(manifestPath: string): ModuleManifest {
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (e) {
    throw createError('ModuleManifestInvalid', {
      file: manifestPath,
      message: `The framework could not read module manifest '${manifestPath}': ${
        e instanceof Error ? e.message : String(e)
      }. Check the file exists and is readable.`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw createError('ModuleManifestInvalid', {
      file: manifestPath,
      message: `Module manifest '${manifestPath}' is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }

  const validator = getManifestValidator();
  const ok = validator(parsed);
  if (!ok) {
    const reasons = (validator.errors ?? [])
      .map((err) => `${err.instancePath || '<root>'} ${err.message ?? 'failed'}`)
      .join('; ');
    throw createError('ModuleManifestInvalid', {
      file: manifestPath,
      message: `Module manifest '${manifestPath}' failed schema validation: ${reasons}.`,
    });
  }

  return parsed as ModuleManifest;
}

function runPrerequisites(manifest: ModuleManifest, manifestPath: string): void {
  if (!manifest.prerequisites) return;
  for (const prereq of manifest.prerequisites) {
    const tokens = prereq.command.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) {
      throw createError('ModulePrerequisiteFailed', {
        file: manifestPath,
        message:
          `Module '${manifest.name}' prerequisite command is empty after whitespace-split. ` +
          prereq.errorHint,
        errorHint: prereq.errorHint,
      });
    }
    const [file, ...args] = tokens;
    try {
      execFileSync(file, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (e) {
      throw createError('ModulePrerequisiteFailed', {
        file: manifestPath,
        message: `Module '${manifest.name}' prerequisite '${prereq.command}' failed: ${
          e instanceof Error ? e.message : String(e)
        }. ${prereq.errorHint}`,
        errorHint: prereq.errorHint,
      });
    }
  }
}

function detectCollisions(registrations: ModuleRegistration[]): void {
  const seen = new Map<string, string>();
  for (const reg of registrations) {
    const prior = seen.get(reg.name);
    if (prior !== undefined) {
      throw createError('ModuleCollision', {
        file: reg.manifestPath,
        message:
          `Two module manifests declare name '${reg.name}': '${prior}' and '${reg.manifestPath}'. ` +
          `Module names must be unique. Rename one of the modules.`,
      });
    }
    seen.set(reg.name, reg.manifestPath);
  }
}

export function moduleStatePath(
  projectRoot: string,
  name: string,
  key: string,
  opts?: ModuleStateStoreOptions,
): string {
  return resolveModuleStatePath(name, key, projectRoot, opts);
}

export function loadModuleState(
  name: string,
  key: string,
  projectRoot: string,
  opts?: ModuleStateStoreOptions,
): ModuleStateRecord | null {
  const filePath = moduleStatePath(projectRoot, name, key, opts);
  if (!existsSync(filePath)) return null;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw createError('MalformedInput', {
      file: filePath,
      message: `The framework could not read module state '${filePath}': ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw createError('MalformedInput', {
      file: filePath,
      message: `Module state file '${filePath}' is not valid JSON: ${
        e instanceof Error ? e.message : String(e)
      }.`,
    });
  }
  return { name, state: parsed };
}

export function getModuleStateKeys(name: string): string[] {
  const registry = getRegisteredModules();
  const found = registry.find((r) => r.name === name);
  if (!found) return [];
  return found.manifest.stateKeys ?? [];
}

export function assertStateKeyAllowed(name: string, key: string): void {
  const allowed = getModuleStateKeys(name);
  if (!allowed.includes(key)) {
    throw createError('UnknownStateKey', {
      message:
        `Module '${name}' does not declare state key '${key}'. ` +
        `Declared keys: ${
          allowed.length === 0 ? '(none)' : allowed.map((k) => `'${k}'`).join(', ')
        }. ` +
        `Add '${key}' to the module manifest's 'stateKeys' array to enable this write.`,
    });
  }
}

export function listInstalledModules(
  projectRoot: string,
  opts?: ModuleStateStoreOptions,
): string[] {
  const storeRoot = resolveModuleStateRoot(opts?.deps);
  const repoKey = resolveModuleRepoKey(projectRoot, opts?.exec);
  const dir = resolveRepoModuleStateDir(storeRoot, repoKey);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    try {
      const st = statSync(path.join(dir, e));
      if (st.isDirectory()) out.push(e);
    } catch {
      // Skip unreadable entries.
    }
  }
  return localeSort(out);
}

let cachedRegistrations: ModuleRegistration[] | null = null;
let cachedRoot: string | null = null;

export function getRegisteredModules(): ModuleRegistration[] {
  const root = defaultModulesRoot();
  if (cachedRegistrations !== null && cachedRoot === root) return cachedRegistrations;
  cachedRegistrations = safeLoadModules(root);
  cachedRoot = root;
  return cachedRegistrations;
}

function safeLoadModules(root: string): ModuleRegistration[] {
  if (!existsSync(root)) return [];
  return loadModules(root);
}

export function _resetModuleRegistrationCacheForTests(): void {
  cachedRegistrations = null;
  cachedRoot = null;
}

export { ConfigServerError };
