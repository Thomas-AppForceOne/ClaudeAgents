/**
 * Tiny argument parser for R4 maintainer scripts.
 *
 * The R3 CLI (`src/cli/lib/args.ts`) has its own parser tuned for the
 * `gan` surface (per-subcommand specs, F2 error mapping). Maintainer
 * scripts have a narrower need: a small set of recognised flags, plus a
 * pass-through bucket for unknown flags so each script can decide how
 * strict it wants to be (e.g. `lint-stacks` treats unknowns as exit 64,
 * while a future script may forward unknowns to a child process).
 *
 * The parser is intentionally minimal:
 *   - Recognised flags (per `spec`): `--json`, `--quiet`, `--help` are
 *     boolean; `--project-root <path>` takes a string value.
 *   - Both `--flag=value` and `--flag value` shapes are accepted.
 *   - Repeated string flags: last-write-wins.
 *   - Tokens that do not start with `--` (and are not a `--flag value`
 *     value-token) are positionals.
 *   - Tokens that look like flags but are not in `spec.boolean` /
 *     `spec.string` go into `unknown`. The parser does not throw; the
 *     caller decides exit-code semantics.
 *
 * The `projectRoot` field on the return value is a small convenience —
 * it canonicalises the `--project-root` value (or `process.cwd()`) via
 * the determinism module so every script gets the same canonical form
 * that the runtime uses (per F3).
 */

import { canonicalizePath } from '../../src/config-server/determinism/index.js';

export interface ArgsSpec {
  /** Long-form names of recognised boolean flags (without leading `--`). */
  boolean: readonly string[];
  /** Long-form names of recognised string-valued flags. */
  string: readonly string[];
}

export interface ParsedScriptArgs {
  /** Flag values keyed by long-form name (without `--`). */
  flags: Record<string, string | boolean>;
  /** Positional arguments, in source order. */
  positionals: string[];
  /** Unknown flag tokens, in source order. Each entry is the raw token. */
  unknown: string[];
  /**
   * Canonical project root. If `--project-root <path>` was supplied, the
   * string value is canonicalised via the determinism module; otherwise
   * `process.cwd()` is canonicalised the same way.
   */
  projectRoot: string;
}

const RECOGNISED_BOOLEANS = ['json', 'quiet', 'help'] as const;
const RECOGNISED_STRINGS = ['project-root'] as const;

/**
 * Parse maintainer-script argv against `spec`.
 *
 * Tokens that look like flags but are not recognised land in `unknown`.
 * Callers decide whether an unknown is a hard error (exit 64) or a
 * pass-through; `lint-stacks` chooses the former.
 */
export function parseArgs(
  argv: readonly string[],
  spec: ArgsSpec = { boolean: RECOGNISED_BOOLEANS, string: RECOGNISED_STRINGS },
): ParsedScriptArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];

  // Seed boolean defaults so callers can read flags[name] unconditionally.
  for (const name of spec.boolean) {
    flags[name] = false;
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;

    // `--flag=value` form.
    if (token.startsWith('--') && token.includes('=')) {
      const eqIdx = token.indexOf('=');
      const name = token.slice(2, eqIdx);
      const value = token.slice(eqIdx + 1);
      if (spec.string.includes(name)) {
        flags[name] = value;
      } else if (spec.boolean.includes(name)) {
        if (value === 'true') flags[name] = true;
        else if (value === 'false') flags[name] = false;
        else unknown.push(token);
      } else {
        unknown.push(token);
      }
      i += 1;
      continue;
    }

    // `--flag` form (boolean) or `--flag value` (string).
    if (token.startsWith('--') && token.length > 2) {
      const name = token.slice(2);
      if (spec.boolean.includes(name)) {
        flags[name] = true;
        i += 1;
        continue;
      }
      if (spec.string.includes(name)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          // Missing value — treat as unknown so the caller can surface a
          // structured "bad args" exit. We do not invent a value.
          unknown.push(token);
          i += 1;
          continue;
        }
        flags[name] = next;
        i += 2;
        continue;
      }
      unknown.push(token);
      i += 1;
      continue;
    }

    // Anything else is a positional.
    positionals.push(token);
    i += 1;
  }

  const projectRootRaw =
    typeof flags['project-root'] === 'string' ? (flags['project-root'] as string) : process.cwd();
  const projectRoot = canonicalizePath(projectRootRaw);

  return { flags, positionals, unknown, projectRoot };
}
