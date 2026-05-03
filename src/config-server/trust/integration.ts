/**
 * Trust-check integration glue (R5 sprint 3).
 *
 * Bridges the recompute side (`trust/hash.ts`) with the persisted side
 * (`trust/cache-io.ts`) into a single decision the validation pipeline
 * can call. The decision tree:
 *
 *   1. If the project's overlays do not declare any commands, trust
 *      doesn't apply — return `'skipped'` without computing anything.
 *      The contract (F4 + R5) is that trust gates *command execution*;
 *      a config-only project carries no command surface to gate.
 *   2. If `GAN_TRUST=unsafe-trust-all`, the user has opted out — return
 *      `'bypassed'` without recomputing the hash. (We still log the
 *      bypass so audit logs reflect the choice.)
 *   3. Otherwise (mode is `'unset'` or `'strict'`, or any unknown value
 *      — which we conservatively treat as `'strict'`), recompute the
 *      aggregate hash and look it up in the trust cache.
 *      - A matching entry → `'approved'`.
 *      - No matching entry → `'unapproved'` with a single
 *        `UntrustedOverlay` issue.
 *      - A corrupt cache → `'unapproved'` with a single
 *        `TrustCacheCorrupt` issue (degrade to "unapproved" rather than
 *        propagate; the trust path must never crash the validate
 *        pipeline).
 *
 * IO discipline (R5 S3 contract):
 *   - Hash compute via `computeTrustHash` (no inline crypto).
 *   - Cache reads via `readCache` (no `'trust-cache.json'` literal).
 *   - Path canonicalisation via `canonicalizePath` (no raw
 *     `realpathSync`).
 *   - All errors via `createError` (no `throw new Error`).
 *   - All log lines via `logTrustEvent` (no `appendFileSync` here).
 *   - JSON serialisation, when needed, goes through `stableStringify`
 *     elsewhere — this module emits no JSON itself.
 */

import os from 'node:os';

import { canonicalizePath } from '../determinism/index.js';
import { ConfigServerError, createError } from '../errors.js';
import { logTrustEvent } from '../logging/trust-log.js';
import type { Issue } from '../validation/schema-check.js';
import { computeTrustHash } from './hash.js';
import { readCache } from './cache-io.js';
import type { ValidationSnapshot } from '../tools/validate.js';

export type TrustMode = 'unset' | 'strict' | 'unsafe-trust-all';

export type TrustStatus = 'skipped' | 'approved' | 'unapproved' | 'bypassed';

export interface TrustCheckInput {
  projectRoot: string;
  snapshot: ValidationSnapshot;
  /** Override `process.env`. Tests inject a controlled env. */
  env?: NodeJS.ProcessEnv;
  /** Override `os.homedir()`. Tests inject a `mkdtempSync` directory. */
  homeDir?: string;
}

export interface TrustCheckResult {
  status: TrustStatus;
  issues: Issue[];
  /** The recomputed aggregate hash; absent when trust was bypassed/skipped. */
  currentHash?: string;
  trustMode: TrustMode;
}

/**
 * Run the trust gate against `snapshot`. Pure function — every dependency
 * (env, home dir) is injectable for tests.
 */
export function runTrustCheck(input: TrustCheckInput): TrustCheckResult {
  const env = input.env ?? process.env;
  const trustMode = readTrustMode(env);

  if (!projectDeclaresCommands(input.snapshot)) {
    logTrustEvent({
      action: 'check',
      projectRoot: input.projectRoot,
      result: 'skipped',
    });
    return { status: 'skipped', issues: [], trustMode };
  }

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

  // No approval on file → build an UntrustedOverlay issue. The message
  // includes the recomputed hash and the exact remediation command so
  // users can copy-paste the approve invocation.
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

// ---- helpers --------------------------------------------------------------

/**
 * Read `GAN_TRUST` from the supplied env. Mapping:
 *   - empty / undefined        → `'unset'`
 *   - `'strict'`               → `'strict'`
 *   - `'unsafe-trust-all'`     → `'unsafe-trust-all'`
 *   - any other value          → `'strict'` (safe fallback; we never
 *                                  silently bypass on a typo).
 */
function readTrustMode(env: NodeJS.ProcessEnv): TrustMode {
  const raw = env['GAN_TRUST'];
  if (raw === undefined || raw === '') return 'unset';
  if (raw === 'strict') return 'strict';
  if (raw === 'unsafe-trust-all') return 'unsafe-trust-all';
  return 'strict';
}

/**
 * Inspect the project-tier overlay for command-declaring fields. Today we
 * only look at `evaluator.additionalChecks`: a non-empty array means the
 * project has declared commands the framework will run.
 *
 * TODO(post-E1): broaden this predicate when the evaluator's
 * command-fallback path lands. The full set should also include per-stack
 * `auditCmd`/`buildCmd`/`testCmd`/`lintCmd` overrides reachable through
 * the resolved view.
 */
function projectDeclaresCommands(snapshot: ValidationSnapshot): boolean {
  const projectRow = snapshot.overlays.project;
  if (!projectRow || !isObject(projectRow.data)) return false;
  const evaluator = projectRow.data['evaluator'];
  if (!isObject(evaluator)) return false;
  const checks = evaluator['additionalChecks'];
  if (Array.isArray(checks) && checks.length > 0) return true;
  // The `{discardInherited, value}` wrapper form (per C3) — also counts
  // when its `value` is a non-empty array.
  if (isObject(checks) && Array.isArray(checks['value']) && checks['value'].length > 0) {
    return true;
  }
  return false;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Convert a `ConfigServerError` into a `validation/schema-check`-shaped
 * `Issue`. Mirrors the helper in `tools/validate.ts` but is duplicated
 * here so this module does not depend on private helpers in the
 * validation layer.
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
