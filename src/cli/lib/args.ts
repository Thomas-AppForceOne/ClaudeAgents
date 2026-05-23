

/**
 * The CLI's argument parser and the types describing a command's flag surface.
 *
 * This is a deliberately small, dependency-free parser tailored to the `gan`
 * CLI's needs rather than a general option library. A command declares its
 * flags as a {@link CommandSpec}; {@link parseArgs} turns a raw argv into a
 * {@link ParsedArgs} carrying positionals, resolved flag values, and a
 * structured {@link ParseError} on failure.
 *
 * Shared design choices worth stating once:
 * - Parsing never throws; a malformed argv produces a `ParsedArgs` whose
 *   `error` field is set, so callers branch on data rather than catch.
 * - A bare `--` ends flag parsing: every token after it is a positional, even
 *   if it looks like a flag. `doubleDashSeen` records that this happened.
 * - Flags are stored under their long name with the leading `--` stripped, so
 *   `--project-root` is read as `flags['project-root']` regardless of whether
 *   the short or long form was used.
 */

/**
 * Declares one flag a command accepts.
 *
 * @property long the canonical long form including `--` (e.g. `--json`); also
 *   the storage key (minus the `--`) in {@link ParsedArgs.flags}.
 * @property short optional single-dash alias (e.g. `-h`).
 * @property type `boolean` (presence flag) or `string` (consumes a value).
 * @property defaultValue seed value placed in `flags` before parsing; when
 *   omitted, boolean flags still default to `false` and string flags are
 *   simply absent until provided.
 */
export interface FlagSpec {

  long: string;

  short?: string;

  type: 'boolean' | 'string';

  defaultValue?: string | boolean;
}

/**
 * The flag surface a command exposes to {@link parseArgs}.
 *
 * @property flags the declared flags.
 * @property allowUnknownFlags when `true`, a token that looks like a flag but
 *   matches no spec is passed through as a positional instead of producing an
 *   `unknown-flag` error — used by pass-through commands that forward unknown
 *   options downstream. Defaults to rejecting unknown flags.
 */
export interface CommandSpec {

  flags: readonly FlagSpec[];

  allowUnknownFlags?: boolean;
}

/**
 * The result of parsing an argv against a {@link CommandSpec}.
 *
 * @property _ positional arguments, in order (everything that was not a flag,
 *   plus everything after a `--`).
 * @property flags resolved flag values keyed by long name without `--`;
 *   booleans are always present (defaulting to `false`), string flags appear
 *   only once supplied or defaulted.
 * @property doubleDashSeen `true` when a `--` terminator was encountered.
 * @property error set when parsing failed; when present the other fields hold
 *   only what was parsed up to the failure and should not be trusted as
 *   complete.
 */
export interface ParsedArgs {

  _: string[];

  flags: Record<string, string | boolean>;

  doubleDashSeen: boolean;

  error?: ParseError;
}

/**
 * Structured description of a parse failure (returned via
 * {@link ParsedArgs.error}, never thrown).
 *
 * @property kind `unknown-flag` (a flag not in the spec, with unknown flags
 *   disallowed) or `missing-value` (a string flag with no value, or a boolean
 *   flag given an explicit non-`true`/`false` value).
 * @property flag the offending flag token, as the user wrote it.
 * @property message a ready-to-print, human-readable explanation.
 */
export interface ParseError {

  kind: 'unknown-flag' | 'missing-value';

  flag: string;

  message: string;
}

// Look up a flag by either its long or short form. Returns undefined when no
// declared flag matches, which the parser turns into an unknown-flag outcome.
function findFlag(spec: CommandSpec, token: string): FlagSpec | undefined {
  return spec.flags.find((f) => f.long === token || f.short === token);
}

/**
 * Parse a raw argv against a command's flag spec.
 *
 * Recognises three flag forms — `--name=value`, `-x`/`--name value`, and bare
 * boolean flags — and treats everything else as a positional. A `--` token
 * ends flag parsing and forces all remaining tokens to be positionals.
 *
 * Failure is returned, not thrown: on the first malformed token the function
 * sets `out.error` (see {@link ParseError}) and returns immediately, so `_`
 * and `flags` reflect only what was parsed before the error. Recognised
 * failure cases: an unknown flag when `spec.allowUnknownFlags` is falsy; a
 * `--bool=...` whose value is neither `true` nor `false`; and a string flag
 * with no following value (or whose next token looks like another flag).
 *
 * @param argv the raw arguments (already sliced past the command name).
 * @param spec the command's {@link CommandSpec}.
 * @returns the {@link ParsedArgs}; check `.error` before using the rest.
 */
export function parseArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const out: ParsedArgs = {
    _: [],
    flags: {},
    doubleDashSeen: false,
  };

  // Seed defaults before scanning argv so absent flags still have a value:
  // an explicit default wins; otherwise a boolean defaults to false (string
  // flags are left absent until supplied).
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

    // `--` terminates option parsing: everything after it is a positional even
    // if it starts with a dash. Record that we saw it, then drain the rest.
    if (token === '--') {
      out.doubleDashSeen = true;

      for (let j = i + 1; j < argv.length; j += 1) {
        out._.push(argv[j]!);
      }
      break;
    }

    // `--name=value` form: split on the first `=` so values may themselves
    // contain `=`.
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

      // A boolean flag in `=` form only accepts the literal `true`/`false`;
      // any other value (e.g. `--json=1`) is a usage error, surfaced as
      // missing-value rather than silently coerced.
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

    // Space-separated form: `-x` / `--name` (length > 1 so a lone `-` is a
    // positional, e.g. stdin convention).
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

      // A string flag consumes the next token as its value. A following token
      // that starts with `-` is treated as the next flag, not this flag's
      // value, so a forgotten value is reported rather than silently swallowing
      // the next option.
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

    out._.push(token);
    i += 1;
  }

  return out;
}

// Normalise a long flag name to its storage key by dropping a leading `--`.
// Keeps the `flags` map keyed consistently whether the short or long form was
// supplied.
function stripLong(long: string): string {
  return long.startsWith('--') ? long.slice(2) : long;
}

/**
 * The flags every command accepts, spread into each command's own spec.
 *
 * Frozen (the array and each entry) so this shared default cannot be mutated by
 * a command that splices it in. Comprises `--help`/`-h`, `--json`, and
 * `--project-root`.
 */
export const GLOBAL_FLAGS: readonly FlagSpec[] = Object.freeze([
  Object.freeze({ long: '--help', short: '-h', type: 'boolean' as const }),
  Object.freeze({ long: '--json', type: 'boolean' as const }),
  Object.freeze({ long: '--project-root', type: 'string' as const }),
]);
