

/**
 * The module registry and module-state I/O for the config-server.
 *
 * A "module" is an installable extension that ships a `manifest.json` declaring
 * its name, exports, optional prerequisites, and the `stateKeys` it is allowed
 * to persist. This module discovers modules from a directory tree, validates
 * each manifest against the bundled JSON schema, enforces name uniqueness, runs
 * declared prerequisite commands, and exposes read access to per-module state
 * plus the allowlist gate that write tools call before persisting state.
 *
 * Two cross-cutting guarantees:
 * - Discovery is deterministic: directory entries are locale-sorted and the
 *   final registration list is name-sorted, so the registry order does not
 *   depend on filesystem iteration order.
 * - State-key writes are allowlisted: {@link assertStateKeyAllowed} is the
 *   single gate, and a key absent from the manifest's `stateKeys` is rejected
 *   (THROWN `UnknownStateKey`) before any path or file is created.
 *
 * The registry is process-cached (keyed by modules root) for the lifetime of
 * the process; {@link _resetModuleRegistrationCacheForTests} clears it.
 */
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
// Ajv's ESM/CJS interop ships the constructor either as the module's `default`
// export or as the module object itself depending on the loader; pick whichever
// is present so this works under both module systems.
const Ajv2020: AjvCtor =
  ((AjvImport2020 as unknown as { default?: AjvCtor }).default as AjvCtor | undefined) ??
  (AjvImport2020 as unknown as AjvCtor);

// Compiling an Ajv schema is comparatively expensive, so the manifest validator
// is built once on first use and reused for every manifest in the run.
let manifestValidator: ValidateFunction | null = null;
/** Lazily compile (and memoise) the module-manifest schema validator. */
function getManifestValidator(): ValidateFunction {
  if (manifestValidator !== null) return manifestValidator;
  const ajv = new Ajv2020({ strict: true, allErrors: true, useDefaults: false });
  manifestValidator = ajv.compile(moduleManifestV1);
  return manifestValidator;
}

/**
 * The validated shape of a module's `manifest.json`. Matches the bundled
 * `moduleManifestV1` JSON schema; a parsed manifest is only cast to this type
 * after passing validation.
 *
 * @property name unique module name (registry key).
 * @property schemaVersion manifest schema version; pinned to `1`.
 * @property description human-readable summary.
 * @property exports the symbols/files the module contributes.
 * @property pairsWith optional name of a companion module.
 * @property prerequisites optional commands that must succeed before the module
 *   loads, each paired with an `errorHint` shown if it fails.
 * @property stateKeys optional allowlist of keys the module may persist state
 *   under; a key not listed here cannot be written.
 * @property configKey optional key under which the module reads project config.
 */
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

/**
 * A discovered, validated module.
 *
 * @property name the module's name (copied from the manifest for convenience).
 * @property manifestPath absolute path to the `manifest.json` it was loaded
 *   from.
 * @property manifest the parsed, schema-valid manifest.
 */
export interface ModuleRegistration {
  name: string;
  manifestPath: string;
  manifest: ModuleManifest;
}

/**
 * A module's persisted state for one key.
 *
 * @property name the owning module.
 * @property state the parsed JSON state value (any shape the module stored).
 */
export interface ModuleStateRecord {
  name: string;
  state: unknown;
}

/**
 * The default root under which bundled modules live: `<packageRoot>/src/modules`.
 * Resolved relative to the installed package, so it points at the framework's
 * own modules regardless of the consuming project's cwd.
 */
export function defaultModulesRoot(): string {
  return path.join(resolvePackageRoot(), 'src', 'modules');
}

/**
 * Discover and validate every module under `modulesRoot`.
 *
 * Scans each immediate subdirectory for a `manifest.json`, validates it,
 * runs its prerequisites, and collects a registration. Entries that are not
 * directories or lack a manifest are skipped silently (not every directory is a
 * module). Directory listing is locale-sorted for deterministic processing
 * order, and the returned list is sorted by module name.
 *
 * @param modulesRoot directory containing one subdirectory per module.
 * @returns the registrations, name-sorted; an empty array if `modulesRoot` does
 *   not exist or cannot be read.
 *
 * Failure modes (all THROWN as `ConfigServerError`): an invalid/unreadable
 * manifest → `ModuleManifestInvalid`; a failed prerequisite →
 * `ModulePrerequisiteFailed`; two modules sharing a name → `ModuleCollision`.
 */
export function loadModules(modulesRoot: string): ModuleRegistration[] {
  if (!existsSync(modulesRoot)) return [];
  let entries: string[];
  try {
    entries = readdirSync(modulesRoot);
  } catch {
    return [];
  }

  const registrations: ModuleRegistration[] = [];
  // Locale-sort up front so manifest reading, prerequisite execution, and the
  // collision check all observe a deterministic order independent of the OS's
  // directory iteration order.
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

  // Final sort by module name gives callers a stable, name-keyed registry order
  // regardless of how the directories were laid out on disk.
  registrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return registrations;
}

/**
 * Read, JSON-parse, and schema-validate a single `manifest.json`.
 *
 * @param manifestPath absolute path to the manifest file.
 * @returns the validated manifest (safe to cast to {@link ModuleManifest}).
 * @throws `ConfigServerError('ModuleManifestInvalid')` when the file cannot be
 *   read, is not valid JSON, or fails schema validation — the schema errors are
 *   joined into the message so the author sees exactly what is wrong.
 */
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

/**
 * Run a module's declared prerequisite commands, failing the load if any does.
 *
 * Each prerequisite is a whitespace-delimited command run with `execFileSync`
 * (no shell, so the command string is not subject to shell interpretation).
 * The author-supplied `errorHint` is appended to the thrown message so the user
 * gets actionable guidance (e.g. "install Docker").
 *
 * @param manifest the module whose `prerequisites` to run; a manifest with none
 *   is a no-op.
 * @param manifestPath path attached to thrown errors for context.
 * @throws `ConfigServerError('ModulePrerequisiteFailed')` when a command is
 *   empty after splitting, or exits non-zero / cannot be spawned.
 */
function runPrerequisites(manifest: ModuleManifest, manifestPath: string): void {
  if (!manifest.prerequisites) return;
  for (const prereq of manifest.prerequisites) {
    // Split into argv tokens (file + args) so the command runs without a shell;
    // an all-whitespace command yields zero tokens and is rejected below.
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

/**
 * Enforce module-name uniqueness across all discovered registrations.
 *
 * @param registrations the full set being registered.
 * @throws `ConfigServerError('ModuleCollision')` naming both manifest paths the
 *   first time two modules claim the same name. Module names are the registry
 *   keys, so a duplicate would make lookups ambiguous and must be a hard error.
 */
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

/**
 * Compute the on-disk path of a module's state file for `key`. Thin wrapper
 * over {@link resolveModuleStatePath} kept here so callers in this layer have a
 * single import surface for module state.
 *
 * @param projectRoot the project (used to derive the repo-keyed store dir).
 * @param name owning module.
 * @param key the state key.
 * @param opts optional store overrides (deps/exec seams) for tests.
 * @returns the absolute `<...>/<name>/<key>.json` path. Pure; no I/O.
 */
export function moduleStatePath(
  projectRoot: string,
  name: string,
  key: string,
  opts?: ModuleStateStoreOptions,
): string {
  return resolveModuleStatePath(name, key, projectRoot, opts);
}

/**
 * Load a module's persisted state for `key`.
 *
 * @param name owning module.
 * @param key the state key.
 * @param projectRoot the project whose store is consulted.
 * @param opts optional store overrides.
 * @returns a {@link ModuleStateRecord} wrapping the parsed state, or `null` when
 *   no state file exists for this `(module, key)` — an absent file is a normal
 *   "no state yet" condition, not an error.
 * @throws `ConfigServerError('MalformedInput')` when an existing file cannot be
 *   read, or its contents are not valid JSON.
 */
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

/**
 * The allowlisted state keys a module may write, taken from its manifest.
 *
 * @param name the module to look up.
 * @returns the manifest's `stateKeys`, or an empty array when the module is
 *   unregistered or declares none. An empty result means *no* key is writable.
 */
export function getModuleStateKeys(name: string): string[] {
  const registry = getRegisteredModules();
  const found = registry.find((r) => r.name === name);
  if (!found) return [];
  return found.manifest.stateKeys ?? [];
}

/**
 * Gate a module-state write: assert that `key` is in module `name`'s declared
 * `stateKeys` allowlist. Write tools call this *first*, before any path
 * resolution or I/O, so a disallowed key can never produce a side effect.
 *
 * @param name owning module.
 * @param key the key being written.
 * @throws `ConfigServerError('UnknownStateKey')` when `key` is not allowlisted;
 *   the message lists the declared keys (or `(none)`) and how to permit it.
 *   Returns nothing on success.
 */
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

/**
 * List the modules that have state persisted for this project — i.e. the
 * subdirectory names under the project's repo-keyed module-state directory.
 *
 * This reflects what has actually written state on disk, which may differ from
 * the registered-modules set. The result is locale-sorted for determinism.
 *
 * @param projectRoot the project whose state store is scanned.
 * @param opts optional store overrides (deps/exec seams).
 * @returns the sorted module-directory names; empty when the store directory is
 *   absent or unreadable. Never throws — unreadable entries are skipped.
 */
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

// Process-lifetime cache of the registry, plus the root it was loaded from so a
// changed root invalidates it. Module discovery touches the filesystem and runs
// prerequisite commands, so it is done once and reused.
let cachedRegistrations: ModuleRegistration[] | null = null;
let cachedRoot: string | null = null;

/**
 * Return the registered modules, loading and caching them on first call.
 *
 * Uses {@link defaultModulesRoot} as the source. The cache is keyed by that
 * root: if the root changes between calls the registry is reloaded. Subsequent
 * calls with the same root return the cached list without re-touching disk.
 *
 * @returns the name-sorted registrations (possibly empty).
 * @throws propagates any error from {@link loadModules} (invalid manifest,
 *   failed prerequisite, name collision) on the load path.
 */
export function getRegisteredModules(): ModuleRegistration[] {
  const root = defaultModulesRoot();
  if (cachedRegistrations !== null && cachedRoot === root) return cachedRegistrations;
  cachedRegistrations = safeLoadModules(root);
  cachedRoot = root;
  return cachedRegistrations;
}

/**
 * Load modules from `root`, treating a non-existent root as "no modules"
 * (empty) rather than an error — installations without bundled modules are
 * valid. Manifest/prerequisite/collision errors from a present root still throw.
 */
function safeLoadModules(root: string): ModuleRegistration[] {
  if (!existsSync(root)) return [];
  return loadModules(root);
}

/**
 * Clear the process-level registry cache. Test-only seam (the `_` prefix marks
 * it as such) so each test can start from a fresh registry rather than one
 * polluted by a prior test's modules root.
 */
export function _resetModuleRegistrationCacheForTests(): void {
  cachedRegistrations = null;
  cachedRoot = null;
}

export { ConfigServerError };
