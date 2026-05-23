/**
 * Trust gate wired into validation phase 4.
 *
 * This is the decision point that asks: "is this project approved to run the
 * commands it declares?" It ties together the hash ({@link computeTrustHash}),
 * the approval cache ({@link readCache}), and the `GAN_TRUST` environment knob,
 * and emits a trust-log event for every outcome so the decision is auditable.
 *
 * The check only matters for projects that declare commands — specifically a
 * non-empty `evaluator.additionalChecks` in the *project* overlay. A project
 * that declares none is `skipped` (nothing to gate). The status ladder is:
 * - `skipped` — no project-declared commands; trust is irrelevant.
 * - `bypassed` — `GAN_TRUST=unsafe-trust-all` overrode the gate (escape hatch).
 * - `approved` — a cache entry matches the current (root, hash) pair.
 * - `unapproved` — commands declared but no matching approval (or the cache was
 *   corrupt); an `UntrustedOverlay`/`TrustCacheCorrupt` issue is returned.
 *
 * Failures here are returned as *data* (status + issues), not thrown — a
 * corrupt cache becomes an `unapproved` result carrying the corruption issue,
 * so a tampered cache fails closed rather than crashing the validator. Only an
 * unexpected non-`ConfigServerError` from the cache read would propagate.
 */

import os from 'node:os';

import { canonicalizePath } from '../determinism/index.js';
import { ConfigServerError, createError } from '../errors.js';
import { logTrustEvent } from '../logging/trust-log.js';
import type { Issue } from '../validation/schema-check.js';
import { computeTrustHash } from './hash.js';
import { readCache } from './cache-io.js';
import type { ValidationSnapshot } from '../tools/validate.js';

/**
 * The `GAN_TRUST` mode. `unset` is the no-env-var default; `strict` enforces
 * the gate; `unsafe-trust-all` bypasses it. Any unrecognised non-empty value is
 * coerced to `strict` (see {@link readTrustMode}) so a typo fails safe.
 */
export type TrustMode = 'unset' | 'strict' | 'unsafe-trust-all';

/** Outcome of a trust check — see the module doc for the status ladder. */
export type TrustStatus = 'skipped' | 'approved' | 'unapproved' | 'bypassed';

/**
 * Input to {@link runTrustCheck}.
 *
 * @property projectRoot the project being gated (raw form; canonicalised
 *   internally for the cache lookup and hashed in raw form by
 *   {@link computeTrustHash}).
 * @property snapshot the validation snapshot; only the project overlay is read,
 *   to decide whether any commands are declared.
 * @property env environment to read `GAN_TRUST` from; defaults to `process.env`
 *   (injection seam for tests).
 * @property homeDir override for the trust-cache home; defaults to
 *   `os.homedir()`.
 */
export interface TrustCheckInput {
  projectRoot: string;
  snapshot: ValidationSnapshot;

  env?: NodeJS.ProcessEnv;

  homeDir?: string;
}

/**
 * Result of {@link runTrustCheck}.
 *
 * @property status the outcome (see {@link TrustStatus}).
 * @property issues issues to surface; non-empty only for `unapproved`
 *   (an `UntrustedOverlay` or `TrustCacheCorrupt` issue).
 * @property currentHash the freshly computed trust hash; present whenever the
 *   hash was computed (i.e. not for `skipped`/`bypassed`, which short-circuit
 *   before hashing).
 * @property trustMode the resolved `GAN_TRUST` mode, echoed for the caller's
 *   diagnostics.
 */
export interface TrustCheckResult {
  status: TrustStatus;
  issues: Issue[];

  currentHash?: string;
  trustMode: TrustMode;
}

/**
 * Decide whether `input.projectRoot` is trusted to run its declared commands,
 * and log the decision.
 *
 * Order is significant and short-circuits cheaply: no declared commands →
 * `skipped` (no hashing); `unsafe-trust-all` → `bypassed` (no hashing or cache
 * read); otherwise hash the config and consult the cache.
 *
 * Side effect: emits exactly one `check` trust-log event per call, whose
 * `result` records the precise outcome (including `unapproved-cache-corrupt`).
 *
 * Failure modes are returned as data: a `TrustCacheCorrupt`
 * {@link ConfigServerError} from the cache read is folded into an `unapproved`
 * result with the corruption issue (fail-closed). A non-`ConfigServerError`
 * from the read is rethrown — that signals an unexpected fault, not a trust
 * decision.
 *
 * @param input see {@link TrustCheckInput}.
 * @returns the {@link TrustCheckResult}.
 */
export function runTrustCheck(input: TrustCheckInput): TrustCheckResult {
  const env = input.env ?? process.env;
  const trustMode = readTrustMode(env);

  // No declared commands → nothing to gate; skip before any hashing or I/O.
  if (!projectDeclaresCommands(input.snapshot)) {
    logTrustEvent({
      action: 'check',
      projectRoot: input.projectRoot,
      result: 'skipped',
    });
    return { status: 'skipped', issues: [], trustMode };
  }

  // Explicit escape hatch: bypass the gate entirely without computing a hash or
  // touching the cache.
  if (trustMode === 'unsafe-trust-all') {
    logTrustEvent({
      action: 'check',
      projectRoot: input.projectRoot,
      result: 'bypassed',
    });
    return { status: 'bypassed', issues: [], trustMode };
  }

  const { aggregateHash } = computeTrustHash(input.projectRoot);
  const homeDir = input.homeDir ?? os.homedir();

  let cache;
  try {
    cache = readCache(homeDir);
  } catch (e) {
    // A corrupt/insecure cache fails closed: treat as unapproved and surface the
    // corruption issue rather than crashing the validator or trusting blindly.
    if (e instanceof ConfigServerError) {
      logTrustEvent({
        action: 'check',
        projectRoot: input.projectRoot,
        hash: aggregateHash,
        result: 'unapproved-cache-corrupt',
      });
      return {
        status: 'unapproved',
        issues: [issueFromConfigServerError(e)],
        currentHash: aggregateHash,
        trustMode,
      };
    }
    throw e;
  }

  // Match on both canonical root and current hash: an approval pinned to a
  // different hash is not a match (the config has changed since approval).
  const canonRoot = canonicalizePath(input.projectRoot);
  const found = cache.approvals.find(
    (a) => a.projectRoot === canonRoot && a.aggregateHash === aggregateHash,
  );

  if (found !== undefined) {
    logTrustEvent({
      action: 'check',
      projectRoot: input.projectRoot,
      hash: aggregateHash,
      result: 'approved',
    });
    return {
      status: 'approved',
      issues: [],
      currentHash: aggregateHash,
      trustMode,
    };
  }

  const remediation =
    `Run \`gan trust approve --project-root=${canonRoot}\` to approve the ` +
    `current overlay contents (hash ${aggregateHash}). The framework ` +
    `requires explicit approval before running project-declared commands.`;
  const err = createError('UntrustedOverlay', {
    path: canonRoot,
    message:
      `Project at '${canonRoot}' has not been approved for command execution. ` +
      `Current trust hash is ${aggregateHash}. ` +
      remediation,
    remediation,
  });

  logTrustEvent({
    action: 'check',
    projectRoot: input.projectRoot,
    hash: aggregateHash,
    result: 'unapproved',
  });

  return {
    status: 'unapproved',
    issues: [issueFromConfigServerError(err)],
    currentHash: aggregateHash,
    trustMode,
  };
}

/**
 * Resolve the `GAN_TRUST` mode from the environment.
 *
 * Absent or empty → `unset`; the two recognised values map through; any other
 * non-empty value is coerced to `strict` so a misspelled mode (e.g.
 * `unsafe-trustall`) never accidentally disables the gate — unknown means
 * enforce.
 *
 * @param env the environment map to read.
 */
function readTrustMode(env: NodeJS.ProcessEnv): TrustMode {
  const raw = env['GAN_TRUST'];
  if (raw === undefined || raw === '') return 'unset';
  if (raw === 'strict') return 'strict';
  if (raw === 'unsafe-trust-all') return 'unsafe-trust-all';
  return 'strict';
}

/**
 * True when the *project* overlay declares at least one evaluator command —
 * i.e. a non-empty `evaluator.additionalChecks`. Only the project tier is
 * consulted: command declarations from other tiers do not arm the trust gate.
 *
 * Both list shapes are accepted: a plain array, or the provenance-wrapped
 * `{ value: [...] }` form. A missing/empty list, or any non-list shape, means
 * "no commands" and returns `false`.
 *
 * @param snapshot the validation snapshot whose `overlays.project` is examined.
 */
function projectDeclaresCommands(snapshot: ValidationSnapshot): boolean {
  const projectRow = snapshot.overlays.project;
  if (!projectRow || !isObject(projectRow.data)) return false;
  const evaluator = projectRow.data['evaluator'];
  if (!isObject(evaluator)) return false;
  const checks = evaluator['additionalChecks'];
  if (Array.isArray(checks) && checks.length > 0) return true;

  if (isObject(checks) && Array.isArray(checks['value']) && checks['value'].length > 0) {
    return true;
  }
  return false;
}

/** Narrow to a non-null, non-array object (a YAML mapping). */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Adapt a {@link ConfigServerError} into a validation {@link Issue} at `error`
 * severity. The location prefers `e.path` over `e.file` here (an
 * `UntrustedOverlay` carries the project root in `path`), the inverse of some
 * other adapters that prefer `file`.
 */
function issueFromConfigServerError(e: ConfigServerError): Issue {
  return {
    code: e.code,
    path: e.path ?? e.file,
    field: e.field,
    message: e.message,
    severity: 'error',
  };
}
