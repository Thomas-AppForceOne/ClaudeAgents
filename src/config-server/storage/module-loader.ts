/**
 * Module loader (M1).
 *
 * Discovery + registration for the M1 modules surface. Replaces R1's
 * "module surface no-op contract" with real machinery so M2 (and future
 * module specs) can plug in without further architectural work.
 *
 * Responsibilities:
 *
 *  1. **Discovery.** `loadModules(modulesRoot)` scans
 *     `<modulesRoot>/<name>/manifest.json`, validates each manifest
 *     against `schemas/module-manifest-v1.json` (ajv), and returns one
 *     `ModuleRegistration` per valid manifest. A directory without a
 *     `manifest.json` is silently skipped (the directory may be a
 *     work-in-progress module, an `__shared__` helper subtree, etc.).
 *
 *  2. **Registration.** Two modules sharing the same `manifest.name`
 *     halt server start with a `ModuleCollision` structured error. Two
 *     modules sharing a `pairsWith` value but distinct `name`s register
 *     without error (the invariant enforces consistency at validate
 *     time, not at registration).
 *
 *  3. **Lifecycle.** Each manifest's `prerequisites[].command` is
 *     executed via `child_process.execFileSync`. The command is
 *     whitespace-split, no shell expansion: the first token is the
 *     executable, remaining tokens are arguments. Exit 0 means pass;
 *     non-zero (or missing binary) means fail. Failure throws via
 *     the central error factory; the manifest's `errorHint` is
 *     reachable via `error.message` and `error.details.errorHint`.
 *
 * Production callers in `tools/reads.ts` / `tools/writes.ts` resolve
 * `modulesRoot` to the package's `src/modules/` directory via
 * `defaultModulesRoot()`. Tests pass a fixture path. There is no env
 * var or runtime knob for module discovery — the resolver is the API.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import AjvImport2020, { type ValidateFunction } from 'ajv/dist/2020.js';

import { localeSort } from '../determinism/index.js';
import { ConfigServerError, createError } from '../errors.js';
import { packageRoot as resolvePackageRoot } from '../package-root.js';
import { moduleManifestV1 } from '../schemas-bundled.js';

// Ajv2020 ships as CJS; under TS NodeNext + esModuleInterop the default
// import is the constructor at runtime but the namespace at type-check
// time. Re-cast via `unknown` so the call site stays a single
// `new Ajv2020(...)`.
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

/**
 * Manifest shape after schema validation. Only fields the loader cares
 * about are typed strictly; unknown additional fields are forbidden by
 * `additionalProperties: false` in the schema, so this interface is the
 * complete surface.
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

/** A registered module: validated manifest + the absolute path it loaded from. */
export interface ModuleRegistration {
  name: string;
  manifestPath: string;
  manifest: ModuleManifest;
}

/**
 * Persisted module-state record. The storage layer treats state as an
 * opaque JSON blob keyed by module name; structure is defined per module.
 */
export interface ModuleStateRecord {
  name: string;
  state: unknown;
}

/**
 * Resolve the production modules root: `<packageRoot>/src/modules/`.
 * Tests pass an explicit `modulesRoot` and avoid this helper.
 */
export function defaultModulesRoot(): string {
  return path.join(resolvePackageRoot(), 'src', 'modules');
}

/**
 * Discover and register every module under `modulesRoot`.
 *
 * Pipeline per directory entry:
 *
 *   1. Skip if not a directory.
 *   2. Skip if it has no `manifest.json` (no error — discovery is opt-in).
 *   3. Read + JSON-parse the manifest.
 *   4. Validate against `module-manifest-v1`. Failure = `ModuleManifestInvalid`.
 *   5. Run each `prerequisites[].command` via `execFileSync`. Failure =
 *      `ModulePrerequisiteFailed` whose message includes the manifest's
 *      `errorHint`.
 *   6. Append a `ModuleRegistration`.
 *
 * After the loop runs, `name` collisions raise `ModuleCollision`.
 *
 * Output is sorted by `name` (locale sort) so registry iteration order
 * is deterministic.
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

  // Sort by name so consumer iteration is deterministic.
  registrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return registrations;
}

/**
 * Read + parse + ajv-validate a manifest file. Throws via the central
 * error factory on any failure (file unreadable, invalid JSON, schema
 * violation). Per AC5 a schema-invalid manifest prevents server start.
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
 * Run every prerequisite command for a manifest. Each command is
 * whitespace-split (no shell expansion) and dispatched via
 * `execFileSync`. Non-zero exit, missing binary, or any spawn error
 * counts as failure and throws `ModulePrerequisiteFailed`. The thrown
 * error's `message` includes the manifest's `errorHint`, and a
 * `details.errorHint` field carries the same string for callers that
 * prefer structured access.
 */
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
        message:
          `Module '${manifest.name}' prerequisite '${prereq.command}' failed: ${
            e instanceof Error ? e.message : String(e)
          }. ${prereq.errorHint}`,
        errorHint: prereq.errorHint,
      });
    }
  }
}

/**
 * Halt server start when two registered modules share a `name`. Names
 * are the registration key; `pairsWith` collisions are NOT rejected
 * here (the `pairs-with-consistency` invariant decides whether a
 * `pairsWith` value is allowed).
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

// ---- module state I/O (zone 2) -------------------------------------------

/**
 * Resolve the on-disk state file for a module under
 * `<projectRoot>/.gan-state/modules/<name>/state.json`. The path is
 * deterministic and exclusive to this module (per F1's zone-2 rules).
 */
export function moduleStatePath(projectRoot: string, name: string): string {
  return path.join(projectRoot, '.gan-state', 'modules', name, 'state.json');
}

/**
 * Load a module's persisted state. Returns `null` when the state file
 * is absent (no error — modules may have never written state). Read
 * failures and JSON parse failures throw via the factory so callers
 * can distinguish "no state" from "corrupt state".
 */
export function loadModuleState(name: string, projectRoot: string): ModuleStateRecord | null {
  const filePath = moduleStatePath(projectRoot, name);
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
 * List installed module names by scanning `.gan-state/modules/<name>/`
 * subdirectories under `projectRoot`. This is the *state-side* listing
 * (which modules have written persistent state), not the
 * *registration-side* listing (which manifests the loader knows about).
 * Callers usually want the latter (`loadModules()`); this helper is
 * preserved for the durable-state surface.
 */
export function listInstalledModules(projectRoot: string): string[] {
  const dir = path.join(projectRoot, '.gan-state', 'modules');
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

// ---- registration cache --------------------------------------------------

let cachedRegistrations: ModuleRegistration[] | null = null;
let cachedRoot: string | null = null;

/**
 * Cached production view of the registered modules. Delegates to
 * `loadModules(defaultModulesRoot())` and memoises the result for the
 * server-process lifetime so the read-side tools do not pay the
 * scan + ajv cost on every call.
 *
 * Tests should NOT use this; they pass `modulesRoot` explicitly through
 * `loadModules` to keep state isolated.
 */
export function getRegisteredModules(): ModuleRegistration[] {
  const root = defaultModulesRoot();
  if (cachedRegistrations !== null && cachedRoot === root) return cachedRegistrations;
  cachedRegistrations = safeLoadModules(root);
  cachedRoot = root;
  return cachedRegistrations;
}

/**
 * Wrap `loadModules` in a guard that returns `[]` when the production
 * modules root does not exist on disk (e.g. tests running before any
 * concrete module ships). Manifest errors and collisions still throw.
 */
function safeLoadModules(root: string): ModuleRegistration[] {
  if (!existsSync(root)) return [];
  return loadModules(root);
}

/** Reset the registration cache. Test-only. */
export function _resetModuleRegistrationCacheForTests(): void {
  cachedRegistrations = null;
  cachedRoot = null;
}

/** Re-export the structured-error class so callers can `instanceof` check. */
export { ConfigServerError };
