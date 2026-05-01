/**
 * R3 sprint 1 — bespoke arg parser.
 *
 * No external dependency: per PROJECT_CONTEXT.md, R3 ships no new deps.
 * The parser is small enough to own; the surface we need is narrow.
 *
 * Surface:
 *   - `--flag=value` (one token)
 *   - `--flag value` (two tokens; consumes the next non-flag-looking token)
 *   - `-h` and `--help` (treated as boolean help)
 *   - `--json` (boolean)
 *   - `--project-root <path>` (string)
 *   - positional args
 *   - `--` terminator: every subsequent token becomes a positional
 *   - repeated flags: last-write-wins for scalars; help/json toggles stay true
 *   - missing-value detection: `--project-root` with no following token is
 *     a structured error, not a throw
 *   - unknown-flag detection: returns an error rather than throwing, so the
 *     dispatcher can render a one-liner with a `--help` pointer
 *
 * The parser is **value-shape agnostic**: it never coerces types. Callers
 * decide how to interpret string values.
 */

export interface FlagSpec {
  /** Long form, e.g. `--json`. Always required. */
  long: string;
  /** Optional short form, e.g. `-h`. */
  short?: string;
  /** `boolean`: presence-only. `string`: requires a value (= or next token). */
  type: 'boolean' | 'string';
  /** Default value. */
  defaultValue?: string | boolean;
}

export interface CommandSpec {
  /** Flags supported by this command (or globally, when no command yet). */
  flags: readonly FlagSpec[];
  /**
   * If true, unknown flags are still allowed (treated as positional). The
   * dispatcher uses `false` so unknown flags surface as exit-64 errors.
   */
  allowUnknownFlags?: boolean;
}

export interface ParsedArgs {
  /** Positional arguments, in order. */
  _: string[];
  /** Flag values keyed by long form (without the leading `--`). */
  flags: Record<string, string | boolean>;
  /** Whether `--` was seen during parse (terminator). */
  doubleDashSeen: boolean;
  /** A parse error, if any; structured for the dispatcher. */
  error?: ParseError;
}

export interface ParseError {
  /** `unknown-flag` | `missing-value`. */
  kind: 'unknown-flag' | 'missing-value';
  /** The offending token (e.g. `--nope`, `--project-root`). */
  flag: string;
  /** Human-readable summary, suitable for stderr. */
  message: string;
}

function findFlag(spec: CommandSpec, token: string): FlagSpec | undefined {
  return spec.flags.find((f) => f.long === token || f.short === token);
}

/**
 * Parse `argv` against `spec`. Never throws; structured failures surface as
 * `error` on the returned object so the dispatcher can map them to exit
 * codes deterministically.
 */
export function parseArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const out: ParsedArgs = {
    _: [],
    flags: {},
    doubleDashSeen: false,
  };

  // Seed defaults so consumers can read flags[name] unconditionally.
  for (const f of spec.flags) {
    if (f.defaultValue !== undefined) {
      out.flags[stripLong(f.long)] = f.defaultValue;
    } else if (f.type === 'boolean') {
      out.flags[stripLong(f.long)] = false;
    }
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;

    if (token === '--') {
      out.doubleDashSeen = true;
      // Everything after `--` is positional, including dash-prefixed tokens.
      for (let j = i + 1; j < argv.length; j += 1) {
        out._.push(argv[j]!);
      }
      break;
    }

    // `--flag=value` form: split on the first `=`.
    if (token.startsWith('--') && token.includes('=')) {
      const eqIdx = token.indexOf('=');
      const name = token.slice(0, eqIdx);
      const value = token.slice(eqIdx + 1);
      const flag = findFlag(spec, name);
      if (!flag) {
        if (spec.allowUnknownFlags) {
          out._.push(token);
          i += 1;
          continue;
        }
        out.error = {
          kind: 'unknown-flag',
          flag: name,
          message: `Unknown flag: ${name}. Run with --help to see supported flags.`,
        };
        return out;
      }
      // Boolean flags don't accept `=value`; treat as malformed only when the
      // value is not a boolean-string. We accept `=true`/`=false` as a kindness
      // to scripted callers, but `--json=anything-else` is an error.
      if (flag.type === 'boolean') {
        if (value === 'true') {
          out.flags[stripLong(flag.long)] = true;
        } else if (value === 'false') {
          out.flags[stripLong(flag.long)] = false;
        } else {
          out.error = {
            kind: 'missing-value',
            flag: name,
            message: `Flag ${name} does not accept a value.`,
          };
          return out;
        }
      } else {
        out.flags[stripLong(flag.long)] = value;
      }
      i += 1;
      continue;
    }

    // Long or short flag form: `--flag` or `-h` (no `=`).
    if (token.startsWith('-') && token.length > 1) {
      const flag = findFlag(spec, token);
      if (!flag) {
        if (spec.allowUnknownFlags) {
          out._.push(token);
          i += 1;
          continue;
        }
        out.error = {
          kind: 'unknown-flag',
          flag: token,
          message: `Unknown flag: ${token}. Run with --help to see supported flags.`,
        };
        return out;
      }
      if (flag.type === 'boolean') {
        out.flags[stripLong(flag.long)] = true;
        i += 1;
        continue;
      }
      // String flag: consume next token as value. Reject if missing or if
      // the next token looks like another flag (defensive).
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        out.error = {
          kind: 'missing-value',
          flag: token,
          message: `Flag ${token} requires a value.`,
        };
        return out;
      }
      out.flags[stripLong(flag.long)] = next;
      i += 2;
      continue;
    }

    // Positional argument.
    out._.push(token);
    i += 1;
  }

  return out;
}

function stripLong(long: string): string {
  return long.startsWith('--') ? long.slice(2) : long;
}

/**
 * The CLI's global flag set. Subcommands extend this.
 *
 * Boolean help is intentionally `--help` AND `-h`. `--json` and
 * `--project-root` are surfaced globally so every read subcommand can pick
 * them up without redeclaring.
 */
export const GLOBAL_FLAGS: readonly FlagSpec[] = Object.freeze([
  Object.freeze({ long: '--help', short: '-h', type: 'boolean' as const }),
  Object.freeze({ long: '--json', type: 'boolean' as const }),
  Object.freeze({ long: '--project-root', type: 'string' as const }),
]);
