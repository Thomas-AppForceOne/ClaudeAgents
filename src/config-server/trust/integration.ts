

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

  env?: NodeJS.ProcessEnv;

  homeDir?: string;
}

export interface TrustCheckResult {
  status: TrustStatus;
  issues: Issue[];

  currentHash?: string;
  trustMode: TrustMode;
}

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

function readTrustMode(env: NodeJS.ProcessEnv): TrustMode {
  const raw = env['GAN_TRUST'];
  if (raw === undefined || raw === '') return 'unset';
  if (raw === 'strict') return 'strict';
  if (raw === 'unsafe-trust-all') return 'unsafe-trust-all';
  return 'strict';
}

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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function issueFromConfigServerError(e: ConfigServerError): Issue {
  return {
    code: e.code,
    path: e.path ?? e.file,
    field: e.field,
    message: e.message,
    severity: 'error',
  };
}
