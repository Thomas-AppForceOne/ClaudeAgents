/**
 * Full validation pipeline (phases 1 + 2 + 3 + 4).
 *
 * Direct library entry points for the three F2 validation tools:
 *
 *   - `validateAll({ projectRoot })` — runs the four-phase pipeline:
 *       phase 1 (discovery) → enumerates every stack file across the three
 *         tiers (project, user, built-in) and every overlay tier (default,
 *         user, project). Module discovery is a no-op (M1 lands real
 *         modules).
 *       phase 2 (schema validation) → validates each discovered file's body
 *         against `stackV1` / `overlayV1` via ajv. Multiple violations in
 *         one file are reported as multiple issues; a bad file does not
 *         halt the pipeline.
 *       phase 3 (cross-file invariants) → runs every R1-owned invariant
 *         from `src/config-server/invariants/` via `runAllInvariants`.
 *         Each invariant returns 0+ issues; all are collected (no
 *         short-circuit). Order is the registry's deterministic order
 *         (alphabetical by id).
 *       phase 4 (trust check, R5 S3) → delegates to
 *         `trust/integration.runTrustCheck`. Reports an
 *         `UntrustedOverlay` issue when the project declares commands
 *         and the current overlay hash is not approved in
 *         `~/.claude/gan/trust-cache.json`. Skipped when the project
 *         declares no commands; bypassed via the trust-mode env knob.
 *
 *   - `validateStack({ projectRoot, name })` — single-stack equivalent:
 *       loads the named stack via the C5 three-tier resolver, runs phase 2
 *       on that one file. Errors from the loader (`MissingFile`,
 *       `InvalidYAML`) are converted into issues, never thrown.
 *
 *   - `validateOverlay({ projectRoot, tier })` — single-overlay equivalent:
 *       loads the named overlay tier and runs phase 2 on the file. A
 *       missing overlay file is OK (overlays are optional at every tier);
 *       the function returns `{ issues: [] }` in that case.
 *
 * Issues are F2-shaped objects (see `Issue` in `validation/schema-check`).
 * Issues are not thrown; the orchestrator decides what is fatal. Only
 * structural errors (e.g. an input that fails `requireProjectRoot`)
 * propagate as `ConfigServerError`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePath, localeSort } from '../determinism/index.js';
import { ConfigServerError } from '../errors.js';
import { runAllInvariants } from '../invariants/index.js';
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

export type { Issue };

/**
 * Per-stack snapshot row. `data` and `prose` are absent if the file failed
 * to parse (the failure is recorded as an issue against the same path).
 */
export interface SnapshotStackRow {
  tier: StackTier;
  path: string;
  data?: unknown;
  prose?: { before: string; after: string };
}

/**
 * Per-overlay snapshot row. Same convention as the stack row.
 */
export interface SnapshotOverlayRow {
  path: string;
  data?: unknown;
  prose?: { before: string; after: string };
}

/**
 * Validation snapshot threaded through phases 1 → 2 → 3. Phase 1 fills in
 * `stackFiles` and `overlays`; phase 2 appends to `issues`; phase 3 (stub)
 * does not append (S4 will).
 */
export interface ValidationSnapshot {
  projectRoot: string;
  stackFiles: Map<string, SnapshotStackRow>;
  overlays: {
    default: SnapshotOverlayRow | null;
    user: SnapshotOverlayRow | null;
    project: SnapshotOverlayRow | null;
  };
  modules: never[];
  issues: Issue[];
}

export interface ValidateAllInput {
  projectRoot: string;
}

export interface ValidateStackInput {
  projectRoot: string;
  name: string;
}

export interface ValidateOverlayInput {
  projectRoot: string;
  tier: OverlayTier;
}

export interface ValidateContext {
  /** Forwarded to stack/overlay resolvers. Tests use this for the user tier. */
  userHome?: string;
  /**
   * Override `process.env` for the trust check (R5 S3). Tests inject a
   * controlled env so the trust-mode env var does not leak between
   * cases.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Override `os.homedir()` for the trust check (R5 S3). Tests inject a
   * `mkdtempSync` directory so the trust cache lookup never reaches the
   * real home directory.
   */
  homeDir?: string;
}

// ---- public API -----------------------------------------------------------

/**
 * Run the full validation pipeline (phases 1 + 2 + 3 + 4).
 *
 * Phase 4 (R5 S3) is the trust gate: when the project's overlays
 * declare commands and the user has not approved the current overlay
 * contents, `validateAll` reports an `UntrustedOverlay` issue. Issue
 * order is stable: phase-1 discovery issues, then phase-2 schema
 * issues, then phase-3 invariant issues, then phase-4 trust issues.
 *
 * Returns a flat list of issues. An empty list means the project
 * passed every phase, including the trust gate.
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
 * Validate a single stack file, resolved through C5's three-tier lookup.
 * Returns issues for parse + schema failures. A `MissingFile` from the
 * resolver becomes a `MissingFile` issue (not a thrown error) so callers
 * receive a uniform shape.
 */
export function validateStack(
  input: ValidateStackInput,
  ctx: ValidateContext = {},
): { issues: Issue[] } {
  const root = canonicalizePath(input.projectRoot);
  const issues: Issue[] = [];
  const opts: ResolveStackOptions = ctx.userHome ? { userHome: ctx.userHome } : {};

  let resolved: { path: string; tier: StackTier };
  try {
    resolved = resolveStackFile(input.name, root, opts);
  } catch (e) {
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
 * Validate a single overlay tier. A missing overlay file is OK at every
 * tier (overlays are optional); the function returns `{ issues: [] }` in
 * that case.
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

// ---- phase 1: discovery ---------------------------------------------------

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
 * Phase 1 — discovery.
 *
 * Enumerates every stack file across the three tiers and every overlay
 * tier. Stack files are keyed by `<tier>:<path>` so a fork at multiple
 * tiers (project shadow + built-in) records both. File-not-found is
 * **not** a phase-1 error; only `MissingFile` issues for *referenced*
 * files (e.g. an overlay's `stack.override` naming an unknown stack) are
 * raised here.
 *
 * Module discovery is a no-op until M1 ships.
 */
function runPhase1Discovery(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const root = snapshot.projectRoot;

  // Built-in stacks: <projectRoot>/stacks/*.md
  enumerateBuiltinStacks(root).forEach((p) => {
    snapshot.stackFiles.set(`builtin:${p}`, { tier: 'builtin', path: p });
  });

  // Project-tier stacks: <projectRoot>/.claude/gan/stacks/*.md
  enumerateTierStacks(path.join(root, '.claude', 'gan', 'stacks')).forEach((p) => {
    snapshot.stackFiles.set(`project:${p}`, { tier: 'project', path: p });
  });

  // User-tier stacks: <userHome>/.claude/gan/stacks/*.md
  const userHome = resolveUserHomeForDiscovery(ctx.userHome);
  if (userHome) {
    enumerateTierStacks(path.join(userHome, '.claude', 'gan', 'stacks')).forEach((p) => {
      snapshot.stackFiles.set(`user:${p}`, { tier: 'user', path: p });
    });
  }

  // Overlays: load each tier (each is optional; null is fine).
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

  // Cross-tier reference check: project overlay's `stack.override` lists
  // must name stacks that exist at some tier. Unknown names → MissingFile.
  checkStackOverrideReferences(snapshot, ctx);
}

/**
 * Enumerate `*.md` files in `<projectRoot>/stacks/`. Returns absolute
 * paths in `localeSort` order. Returns `[]` if the directory is absent —
 * absence is not an error here (the project may simply not declare any
 * built-in stacks). Sub-directories are skipped.
 */
function enumerateBuiltinStacks(projectRoot: string): string[] {
  return enumerateTierStacks(path.join(projectRoot, 'stacks'));
}

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

function resolveUserHomeForDiscovery(explicit?: string): string | null {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const fromEnv = process.env.GAN_USER_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return typeof home === 'string' && home.length > 0 ? home : null;
}

/**
 * Check whether overlays referencing stacks via `stack.override` name a
 * stack the framework can resolve. Unknown names → `MissingFile` issue
 * naming the offending overlay file and the missing stack.
 *
 * Per C3, `stack.override` may be a bare list of names or a structured
 * `{ discardInherited, value: [...] }` wrapper. Both forms are honoured.
 */
function checkStackOverrideReferences(snapshot: ValidationSnapshot, ctx: ValidateContext): void {
  const opts: ResolveStackOptions = ctx.userHome ? { userHome: ctx.userHome } : {};
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

function extractOverrideNames(override: unknown): string[] {
  if (Array.isArray(override)) {
    return override.filter((v): v is string => typeof v === 'string');
  }
  if (isObject(override) && Array.isArray(override.value)) {
    return override.value.filter((v): v is string => typeof v === 'string');
  }
  return [];
}

// ---- phase 2: schema validation ------------------------------------------

/**
 * Phase 2 — per-file schema validation.
 *
 * Walks every discovered stack and overlay file; validates each against
 * its corresponding schema. A bad file contributes one or more issues but
 * does not halt the phase. Output ordering is deterministic: stack files
 * are visited in `localeSort` order of their snapshot key.
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
 * Read + parse + ajv-validate a stack file by absolute path. On parse
 * failure (`InvalidYAML` / `MalformedInput` / `MissingFile`), pushes one
 * issue and returns. On schema failure, pushes one issue per ajv error.
 *
 * If `prefetched` is supplied (phase 1 snapshot row), the freshly parsed
 * data + prose are written back into the row so phase 3 (S4) can use
 * the snapshot without re-reading.
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

// ---- phase 3: cross-file invariants ---------------------------------------

/**
 * Phase 3 — cross-file invariants.
 *
 * Delegates to the registry under `src/config-server/invariants/` (per
 * R1's single-implementation rule). Each invariant runs against the
 * snapshot built by phases 1 + 2 and returns 0+ issues; the registry
 * concatenates without short-circuit so a violating invariant does not
 * mask later checks. Issues are merged into the snapshot's issue list
 * after phase-2 issues so callers see a stable phase-1 → phase-2 →
 * phase-3 ordering.
 *
 * The 8 R1-owned F3 invariants are: `pairsWith.consistency`,
 * `cacheEnv.no_conflict`, `additionalContext.path_resolves`,
 * `path.no_escape`, `overlay.tier_apiVersion`, `stack.tier_apiVersion`,
 * `detection.tier3_only`, `stack.no_draft_banner`. The 9th catalogued
 * invariant (`trust.approved`) is owned by R5 and is omitted until R5
 * ships.
 */
function runPhase3Invariants(snapshot: ValidationSnapshot): void {
  const produced = runAllInvariants(snapshot);
  if (produced.length > 0) snapshot.issues.push(...produced);
}

// ---- phase 4: trust check (R5 S3) ----------------------------------------

/**
 * Phase 4 — trust check.
 *
 * Delegates to `trust/integration.runTrustCheck`. The trust gate fires
 * only when the project-tier overlay declares commands the framework
 * would run; otherwise the phase is a no-op and `runTrustCheck`
 * returns `'skipped'`. Issues are appended after phase-3 issues to
 * preserve the stable phase ordering callers rely on.
 *
 * The trust-mode env var is read inside `runTrustCheck` only — this
 * phase wrapper passes through `ctx.env` and `ctx.homeDir` for tests
 * but does not consult either directly.
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

// ---- helpers --------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function missingStackMessage(name: string, original: string): string {
  return `The framework could not find stack '${name}' in any tier. Create '.claude/gan/stacks/${name}.md' (project tier) or 'stacks/${name}.md' (built-in tier). Resolver detail: ${original}`;
}

function issueFromConfigServerError(e: ConfigServerError): Issue {
  return {
    code: e.code,
    path: e.file ?? e.path,
    field: e.field,
    message: e.message,
    severity: 'error',
  };
}

// ---- exported helpers for tests ------------------------------------------

/**
 * Test-only helper: run only phase 1 and return the snapshot. Useful for
 * verifying discovery without paying for schema validation.
 */
export function _runPhase1ForTests(
  projectRoot: string,
  ctx: ValidateContext = {},
): ValidationSnapshot {
  const snapshot = createSnapshot(projectRoot);
  runPhase1Discovery(snapshot, ctx);
  return snapshot;
}
