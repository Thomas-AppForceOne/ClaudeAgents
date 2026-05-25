/**
 * Validation tools for the config-server — the diagnostic surface.
 *
 * This module answers "is this project's config well-formed and internally
 * consistent?" without mutating anything. Its centrepiece, {@link validateAll},
 * runs a fixed four-phase pipeline over a single {@link ValidationSnapshot}:
 *
 *   1. **Discovery** — enumerate every stack file (built-in, project, user
 *      tiers) and load the three overlays into the snapshot; check stack-override
 *      references and load module registrations.
 *   2. **Schema validation** — validate each discovered stack/overlay body
 *      against its schema.
 *   3. **Invariants** — run the cross-document checks in `../invariants`.
 *   4. **Trust** — run the trust gate (`../trust/integration`).
 *
 * Each phase appends to the shared `snapshot.issues`, so a later phase still
 * runs even when an earlier one found problems — the result is the *complete*
 * set of issues, not just the first. {@link validateStack} and
 * {@link validateOverlay} are narrow single-target variants that skip the full
 * pipeline.
 *
 * Error policy throughout: an *expected* config problem surfaced as a
 * {@link ConfigServerError} is converted to an {@link Issue} and collected; any
 * other thrown error is an unexpected fault and propagates. Iteration over
 * discovered files is locale-sorted so the issue ordering is deterministic.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort } from '../determinism/index.js';
import { ConfigServerError } from '../errors.js';
import { runAllInvariants } from '../invariants/index.js';
import { packageRoot as resolvePackageRoot } from '../package-root.js';
import {
  defaultModulesRoot,
  loadModules,
  type ModuleRegistration,
} from '../storage/module-loader.js';
import { loadOverlay, type LoadedOverlay, type OverlayTier } from '../storage/overlay-loader.js';
import { parseYamlBlock } from '../storage/yaml-block-parser.js';
import {
  resolveStackFile,
  type ResolveStackOptions,
  type StackTier,
} from '../resolution/stack-resolution.js';
import { runTrustCheck } from '../trust/integration.js';
import {
  validateOverlayBodyAgainstSchema,
  validateStackBodyAgainstSchema,
  type Issue,
} from '../validation/schema-check.js';
import { checkUserOverlayForbiddenFields } from '../validation/user-tier-forbidden.js';
import { checkClarifierTimeoutRange } from '../validation/clarifier-timeout-check.js';

/**
 * Re-export of the schema-validation {@link Issue} type, so callers (and the
 * invariant modules that import the snapshot types from here) get the issue
 * shape without reaching into the validation layer.
 */
export type { Issue };

/**
 * One discovered stack file in the snapshot.
 *
 * @property tier which tier supplied it (`builtin`/`project`/`user`); drives
 *   several invariants.
 * @property path the absolute file path.
 * @property data the parsed YAML body; populated lazily during phase 2 (absent
 *   until then, or if parsing failed).
 * @property prose the Markdown surrounding the YAML block; populated alongside
 *   `data`. Used by the draft-banner invariant.
 */
export interface SnapshotStackRow {
  tier: StackTier;
  path: string;
  data?: unknown;
  prose?: { before: string; after: string };
}

/**
 * One loaded overlay document in the snapshot.
 *
 * @property path the absolute overlay file path.
 * @property data the parsed body (loaded during discovery).
 * @property prose the surrounding Markdown.
 */
export interface SnapshotOverlayRow {
  path: string;
  data?: unknown;
  prose?: { before: string; after: string };
}

/**
 * One registered module in the snapshot.
 *
 * @property name the module name.
 * @property manifestPath the module manifest's path.
 * @property pairsWith the stack this module declares it pairs with, when any
 *   (consumed by the pairsWith-consistency invariant).
 */
export interface SnapshotModuleRow {
  name: string;
  manifestPath: string;
  pairsWith?: string;
}

/**
 * The shared, mutable accumulator threaded through all four validation phases.
 *
 * @property projectRoot the canonical project root (canonicalised at creation).
 * @property stackFiles discovered stacks keyed by a tier-prefixed key
 *   (e.g. `project:/abs/path.md`); the prefix lets the same path in two tiers
 *   coexist and gives a stable sort key.
 * @property overlays the three overlay slots; `null` until/unless discovered.
 * @property modules registered modules.
 * @property issues the running list every phase appends to — the pipeline's
 *   output.
 */
export interface ValidationSnapshot {
  projectRoot: string;
  stackFiles: Map<string, SnapshotStackRow>;
  overlays: {
    default: SnapshotOverlayRow | null;
    user: SnapshotOverlayRow | null;
    project: SnapshotOverlayRow | null;
  };
  modules: SnapshotModuleRow[];
  issues: Issue[];
}

/**
 * Input to {@link validateAll}.
 *
 * @property projectRoot the project to validate; canonicalised internally.
 */
export interface ValidateAllInput {
  projectRoot: string;
}

/**
 * Input to {@link validateStack}.
 *
 * @property projectRoot the project context for resolution; canonicalised.
 * @property name the single stack to validate.
 */
export interface ValidateStackInput {
  projectRoot: string;
  name: string;
}

/**
 * Input to {@link validateOverlay}.
 *
 * @property projectRoot the project context; canonicalised.
 * @property tier the single overlay tier to validate.
 */
export interface ValidateOverlayInput {
  projectRoot: string;
  tier: OverlayTier;
}

/**
 * Ambient context for the validate tools; all fields are optional injection
 * seams (production passes `{}` and uses real seams).
 *
 * @property userHome override for the user home, steering `user`-tier
 *   overlay/stack discovery.
 * @property packageRoot override for the installed-package root, steering
 *   built-in stack discovery.
 * @property env environment passed to the trust phase (for `GAN_TRUST`).
 * @property homeDir override for the trust-cache home, passed to the trust
 *   phase.
 * @property modulesRoot override for the module-registry root; when set, only
 *   this root is loaded (no fallback to the production root).
 */
export interface ValidateContext {

  userHome?: string;

  packageRoot?: string;

  env?: NodeJS.ProcessEnv;

  homeDir?: string;

  modulesRoot?: string;
}

/**
 * Validate a project's entire config through the four-phase pipeline.
 *
 * Read-only (no disk writes). Phases run unconditionally and in order, each
 * appending to the shared snapshot, so the returned list is the *complete* set
 * of issues found — an early problem does not abort the remaining phases.
 *
 * Failure modes: expected config problems are returned as `issues`, not thrown;
 * an unexpected (non-`ConfigServerError`) fault inside any phase propagates.
 *
 * @param input see {@link ValidateAllInput}.
 * @param ctx ambient context / injection seams.
 * @returns `{ issues }` — all collected issues, deterministically ordered.
 */
export function validateAll(
  input: ValidateAllInput,
  ctx: ValidateContext = {},
): { issues: Issue[] } {
  const snapshot = createSnapshot(input.projectRoot);
  runPhase1Discovery(snapshot, ctx);
  runPhase2SchemaValidation(snapshot);
  runPhase3Invariants(snapshot);
  runPhase4Trust(snapshot, ctx);
  return { issues: snapshot.issues };
}

/**
 * Validate a single named stack against its schema, resolving it first.
 *
 * Scope is deliberately narrow: this runs only schema validation on the one
 * resolved stack — not the cross-document invariants or trust phase, which need
 * the whole snapshot.
 *
 * Failure modes: a `MissingFile` from resolution becomes a single `MissingFile`
 * issue (with a remediation message) rather than throwing; any other
 * `ConfigServerError`, and any non-`ConfigServerError`, propagates. Schema
 * problems with the resolved file are returned as `issues`.
 *
 * @param input see {@link ValidateStackInput}.
 * @param ctx ambient context; `userHome`/`packageRoot` steer resolution.
 * @returns `{ issues }` for the single stack (possibly empty).
 */
export function validateStack(
  input: ValidateStackInput,
  ctx: ValidateContext = {},
): { issues: Issue[] } {
  const root = canonicalizePath(input.projectRoot);
  const issues: Issue[] = [];
  const opts: ResolveStackOptions = {};
  if (ctx.userHome) opts.userHome = ctx.userHome;
  if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;

  let resolved: { path: string; tier: StackTier };
  try {
    resolved = resolveStackFile(input.name, root, opts);
  } catch (e) {
    // A genuinely missing stack is a user-facing diagnostic, returned as an
    // issue with guidance; other resolution faults propagate.
    if (e instanceof ConfigServerError && e.code === 'MissingFile') {
      issues.push({
        code: 'MissingFile',
        message: missingStackMessage(input.name, e.message),
        severity: 'error',
      });
      return { issues };
    }
    throw e;
  }

  validateStackFileFromDisk(resolved.path, issues);
  return { issues };
}

/**
 * Validate a single overlay tier against its schema.
 *
 * Narrow scope, like {@link validateStack}: schema validation only, on the one
 * loaded overlay.
 *
 * Failure modes: a `ConfigServerError` from loading (e.g. a malformed file) is
 * converted to an issue and returned; other throws propagate. A tier with no
 * overlay file present yields an empty issue list (a normal absence). Schema
 * problems are returned as `issues`.
 *
 * @param input see {@link ValidateOverlayInput}.
 * @param ctx ambient context; `userHome` resolves the `user` tier.
 * @returns `{ issues }` for the single overlay (possibly empty).
 */
export function validateOverlay(
  input: ValidateOverlayInput,
  ctx: ValidateContext = {},
): { issues: Issue[] } {
  const root = canonicalizePath(input.projectRoot);
  const issues: Issue[] = [];

  const overlayLoadOpts = ctx.userHome ? { userHome: ctx.userHome } : {};
  let loaded: LoadedOverlay | null = null;
  try {
    loaded = loadOverlay(input.tier, root, overlayLoadOpts);
  } catch (e) {
    if (e instanceof ConfigServerError) {
      issues.push(issueFromConfigServerError(e));
      return { issues };
    }
    throw e;
  }

  if (!loaded) return { issues };
  validateOverlayBodyAgainstSchema(loaded.path, loaded.data, issues);
  return { issues };
}

/**
 * Build an empty snapshot for `projectRoot`, canonicalising the root up front
 * so every later phase keys on the same canonical path.
 */
function createSnapshot(projectRoot: string): ValidationSnapshot {
  const root = canonicalizePath(projectRoot);
  return {
    projectRoot: root,
    stackFiles: new Map(),
    overlays: { default: null, user: null, project: null },
    modules: [],
    issues: [],
  };
}

/**
 * Load module registrations, honouring a `ctx.modulesRoot` override.
 *
 * When an explicit `modulesRoot` is given, it is loaded directly. Otherwise the
 * production default root is used — but if even *locating* that root fails
 * (`defaultModulesRoot` throws, e.g. in an environment with no install), that
 * is treated as "no modules" and an empty list is returned, so validation still
 * works without a module install. An error *loading* a located root, however,
 * propagates (the explicit `throw e` covers both branches — a `ConfigServerError`
 * and anything else are rethrown identically).
 */
function loadModuleRegistrationsFor(ctx: ValidateContext): ModuleRegistration[] {
  if (typeof ctx.modulesRoot === 'string' && ctx.modulesRoot.length > 0) {
    return loadModules(ctx.modulesRoot);
  }
  let prodRoot: string;
  try {
    prodRoot = defaultModulesRoot();
  } catch {
    // No discoverable modules root (e.g. running outside an install): degrade
    // to "no modules" rather than failing the whole validation.
    return [];
  }
  try {
    return loadModules(prodRoot);
  } catch (e) {

    if (e instanceof ConfigServerError) throw e;
    throw e;
  }
}

/**
 * Phase 1 — discover and load everything later phases reason over.
 *
 * Populates the snapshot with: built-in stacks (from both the package's
 * `stacks/` and the project's own `stacks/`), project- and user-tier stacks,
 * the three overlays, and module registrations. It also runs two eager checks
 * that need discovery context — stack-override references and the user-overlay
 * forbidden-field check — appending their issues to the snapshot.
 *
 * Mutates `snapshot` in place; performs read-only disk I/O. A
 * `ConfigServerError` while loading an overlay is captured as an issue; other
 * throws propagate.
 */
function runPhase1Discovery(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const root = snapshot.projectRoot;

  // Built-in stacks can come from two places: the installed package's `stacks/`
  // and the project's own `stacks/` directory. Both are registered under the
  // `builtin:` key prefix; the map key is the path, so a stack present in both
  // de-dupes to a single entry.
  const pkgRoot = resolvePackageRootForDiscovery(ctx.packageRoot);
  if (pkgRoot) {
    enumerateTierStacks(path.join(pkgRoot, 'stacks')).forEach((p) => {
      snapshot.stackFiles.set(`builtin:${p}`, { tier: 'builtin', path: p });
    });
  }

  enumerateBuiltinStacks(root).forEach((p) => {
    snapshot.stackFiles.set(`builtin:${p}`, { tier: 'builtin', path: p });
  });

  enumerateTierStacks(path.join(root, '.claude', 'gan', 'stacks')).forEach((p) => {
    snapshot.stackFiles.set(`project:${p}`, { tier: 'project', path: p });
  });

  const userHome = resolveUserHomeForDiscovery(ctx.userHome);
  if (userHome) {
    enumerateTierStacks(path.join(userHome, '.claude', 'gan', 'stacks')).forEach((p) => {
      snapshot.stackFiles.set(`user:${p}`, { tier: 'user', path: p });
    });
  }

  const overlayLoadOpts = ctx.userHome ? { userHome: ctx.userHome } : {};
  for (const tier of ['default', 'user', 'project'] as const) {
    try {
      const loaded = loadOverlay(tier, root, overlayLoadOpts);
      if (loaded) {
        snapshot.overlays[tier] = {
          path: loaded.path,
          data: loaded.data,
          prose: loaded.prose,
        };
      }
    } catch (e) {
      if (e instanceof ConfigServerError) {
        snapshot.issues.push(issueFromConfigServerError(e));
      } else {
        throw e;
      }
    }
  }

  checkStackOverrideReferences(snapshot, ctx);

  const userOverlay = snapshot.overlays.user;
  if (userOverlay) {
    checkUserOverlayForbiddenFields(userOverlay.path, userOverlay.data, snapshot.issues);
  }

  // clarifier.draftTimeoutSeconds is valid in both tiers, so the semantic
  // range check runs on every loaded overlay (unlike the user-tier-only
  // forbidden-field check above). An out-of-range integer must surface as
  // InvalidTimeoutValue from the full validate path, not only the schema layer.
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    checkClarifierTimeoutRange(row.path, row.data, snapshot.issues);
  }

  const registrations = loadModuleRegistrationsFor(ctx);
  for (const reg of registrations) {
    const row: { name: string; manifestPath: string; pairsWith?: string } = {
      name: reg.name,
      manifestPath: reg.manifestPath,
    };
    // Only carry pairsWith onto the snapshot row when the manifest actually
    // declares it as a string, so the pairsWith invariant sees a clean optional.
    if (typeof reg.manifest.pairsWith === 'string') {
      row.pairsWith = reg.manifest.pairsWith;
    }
    snapshot.modules.push(row);
  }
}

/** Enumerate a project's own built-in `stacks/` directory (the in-repo tier-3
 * location), delegating to {@link enumerateTierStacks}. */
function enumerateBuiltinStacks(projectRoot: string): string[] {
  return enumerateTierStacks(path.join(projectRoot, 'stacks'));
}

/**
 * List the absolute paths of `*.md` regular files directly in `stacksDir`,
 * locale-sorted for determinism.
 *
 * Fault-tolerant: a missing directory, an unreadable directory, or a `stat`
 * failure on an individual entry all degrade to skipping (returning `[]` or
 * omitting the entry) rather than throwing — discovery should never abort
 * because one tier's directory is absent or briefly unreadable.
 */
function enumerateTierStacks(stacksDir: string): string[] {
  if (!existsSync(stacksDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(stacksDir);
  } catch {
    return [];
  }
  const matched: string[] = [];
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    const full = path.join(stacksDir, name);
    try {
      const st = statSync(full);
      if (!st.isFile()) continue;
    } catch {
      continue;
    }
    matched.push(full);
  }
  return localeSort(matched);
}

/**
 * Resolve the user home for stack/overlay discovery, in precedence order:
 * explicit override → `GAN_USER_HOME` → `HOME`/`USERPROFILE`. Returns `null`
 * when none is set, so the user tier is simply skipped rather than erroring.
 */
function resolveUserHomeForDiscovery(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.GAN_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return typeof home === 'string' && home.length > 0 ? home : null;
}

/**
 * Resolve the installed-package root for built-in stack discovery: the explicit
 * override if given, else the auto-detected package root. Returns `null` when
 * detection throws (e.g. running outside an install), so package-tier built-in
 * stacks are skipped rather than aborting discovery.
 */
function resolvePackageRootForDiscovery(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  try {
    return resolvePackageRoot();
  } catch {
    return null;
  }
}

/**
 * Verify that every stack named in any overlay's `stack.override` resolves to a
 * real stack file, appending a `MissingFile` issue for each dangling reference.
 *
 * Reads overlays already in the snapshot and attempts resolution per name. A
 * `MissingFile` from resolution is the expected "you referenced a stack that
 * doesn't exist" case and becomes an issue; any other thrown error propagates.
 * Mutates `snapshot.issues`.
 */
function checkStackOverrideReferences(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const opts: ResolveStackOptions = {};
  if (ctx.userHome) opts.userHome = ctx.userHome;
  if (ctx.packageRoot) opts.packageRoot = ctx.packageRoot;
  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row || !isObject(row.data)) continue;
    const stackBlock = row.data['stack'];
    if (!isObject(stackBlock)) continue;
    const override = stackBlock['override'];
    const names = extractOverrideNames(override);
    for (const name of names) {
      try {
        resolveStackFile(name, snapshot.projectRoot, opts);
      } catch (e) {
        if (e instanceof ConfigServerError && e.code === 'MissingFile') {
          snapshot.issues.push({
            code: 'MissingFile',
            path: row.path,
            field: '/stack/override',
            message: `Overlay '${row.path}' references stack '${name}' via stack.override, but no stack file with that name exists in any tier. Create the stack file at .claude/gan/stacks/${name}.md or remove the override entry.`,
            severity: 'error',
          });
        } else {
          throw e;
        }
      }
    }
  }
}

/**
 * Pull the list of overridden stack names out of an overlay's `stack.override`,
 * accepting both the plain-array and provenance-wrapped `{ value: [...] }`
 * shapes and dropping non-strings. Returns `[]` for any other shape.
 */
function extractOverrideNames(override: unknown): string[] {
  if (Array.isArray(override)) {
    return override.filter((v): v is string => typeof v === 'string');
  }
  if (isObject(override) && Array.isArray(override.value)) {
    return override.value.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

/**
 * Phase 2 — schema-validate every discovered stack and overlay body.
 *
 * Stacks are validated in locale-sorted key order so issues are deterministic;
 * each stack is (re)read from disk via {@link validateStackFileFromDisk}, which
 * also back-fills the row's parsed `data`/`prose` for phase 3 to consume.
 * Overlays were already parsed during discovery, so their in-memory bodies are
 * validated directly. Mutates `snapshot.issues`.
 */
function runPhase2SchemaValidation(snapshot: ValidationSnapshot): void {
  const stackKeys = localeSort(Array.from(snapshot.stackFiles.keys()));
  for (const key of stackKeys) {
    const row = snapshot.stackFiles.get(key);
    if (!row) continue;
    validateStackFileFromDisk(row.path, snapshot.issues, row);
  }

  for (const tier of ['default', 'user', 'project'] as const) {
    const row = snapshot.overlays[tier];
    if (!row) continue;
    validateOverlayBodyAgainstSchema(row.path, row.data, snapshot.issues);
  }
}

/**
 * Read, parse, and schema-validate one stack file from disk, collecting issues.
 *
 * @param filePath the stack file to validate.
 * @param issues the list to append issues to (mutated).
 * @param prefetched optional snapshot row to back-fill with the parsed
 *   `data`/`prose` as a side effect — this is how phase 2 populates the rows
 *   that phase 3 (invariants) later reads, avoiding a second parse.
 *
 * Failure handling: a read failure becomes a `MissingFile` issue; a YAML parse
 * failure surfaced as `ConfigServerError` becomes an issue; any other thrown
 * parse error propagates. After a successful parse the body is schema-checked.
 */
function validateStackFileFromDisk(
  filePath: string,
  issues: Issue[],
  prefetched?: SnapshotStackRow,
): void {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    issues.push({
      code: 'MissingFile',
      path: filePath,
      message: `The framework could not read stack file '${filePath}': ${
        e instanceof Error ? e.message : String(e)
      }. Check the file exists and is readable.`,
      severity: 'error',
    });
    return;
  }

  let data: unknown;
  try {
    const parsed = parseYamlBlock(text, filePath);
    data = parsed.data;
    if (prefetched) {
      prefetched.data = parsed.data;
      prefetched.prose = parsed.prose;
    }
  } catch (e) {
    if (e instanceof ConfigServerError) {
      issues.push(issueFromConfigServerError(e));
      return;
    }
    throw e;
  }

  validateStackBodyAgainstSchema(filePath, data, issues);
}

/**
 * Phase 3 — run the cross-document invariants over the now-fully-populated
 * snapshot and append their issues. Relies on phase 2 having back-filled each
 * stack row's parsed `data`. Mutates `snapshot.issues`.
 */
function runPhase3Invariants(snapshot: ValidationSnapshot): void {
  const produced = runAllInvariants(snapshot);
  if (produced.length > 0) snapshot.issues.push(...produced);
}

/**
 * Phase 4 — run the trust gate and fold its issues in. The trust check itself
 * returns failures as data (it fails closed on a corrupt cache), so this phase
 * never throws for a trust outcome. Mutates `snapshot.issues`.
 */
function runPhase4Trust(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const result = runTrustCheck({
    projectRoot: snapshot.projectRoot,
    snapshot,
    env: ctx.env,
    homeDir: ctx.homeDir,
  });
  if (result.issues.length > 0) snapshot.issues.push(...result.issues);
}

/** Narrow to a non-null, non-array object (a YAML mapping). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Compose the "stack not found in any tier" diagnostic for {@link
 * validateStack}, listing both tier locations the user could create the file in
 * and appending the resolver's own detail for context.
 */
function missingStackMessage(name: string, original: string): string {
  return `The framework could not find stack '${name}' in any tier. Create '.claude/gan/stacks/${name}.md' (project tier) or 'stacks/${name}.md' (built-in tier). Resolver detail: ${original}`;
}

/**
 * Adapt a {@link ConfigServerError} into a validation {@link Issue} at `error`
 * severity. Location prefers `e.file` over `e.path` here (file-oriented loaders
 * carry the path in `file`) — the inverse of the trust adapter, which prefers
 * `path`.
 */
function issueFromConfigServerError(e: ConfigServerError): Issue {
  return {
    code: e.code,
    path: e.file ?? e.path,
    field: e.field,
    message: e.message,
    severity: 'error',
  };
}

/**
 * Test-only entry point that runs *just* phase-1 discovery and returns the
 * populated snapshot, so tests (and {@link computeProjectSummary} in `reads.ts`)
 * can inspect discovered overlays/stacks/modules without the schema, invariant,
 * and trust phases. The leading underscore marks it as not part of the public
 * tool surface.
 *
 * @param projectRoot the project to discover.
 * @param ctx ambient context / injection seams.
 * @returns the snapshot after discovery only.
 */
export function _runPhase1ForTests(
  projectRoot: string,
  ctx: ValidateContext = {},
): ValidationSnapshot {
  const snapshot = createSnapshot(projectRoot);
  runPhase1Discovery(snapshot, ctx);
  return snapshot;
}
