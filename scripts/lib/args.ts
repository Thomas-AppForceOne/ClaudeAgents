/**
 * Minimal, dependency-free argv parser shared by every `scripts/` CLI.
 *
 * The parser is deliberately small: it understands `--flag`, `--flag=value`,
 * and `--key value` for a fixed, caller-declared set of names, and collects
 * everything else into `positionals`/`unknown` for the caller to reject. It
 * does not throw on bad input — unrecognised or malformed flags are returned
 * as data in `unknown` so each script can emit its own usage error and exit
 * with the shared `BAD_ARGS` code. The one always-present derived field is
 * `projectRoot`, canonicalised from `--project-root` (or the cwd) so every
 * script sees a stable, symlink-resolved root.
 */
import { canonicalizePath } from '../../src/config-server/determinism/index.js';

/**
 * Declares which flag names a script accepts and how each is typed. Names are
 * given without the leading `--`. A name in {@link ArgsSpec.boolean} is a
 * presence flag (default `false`, also accepts `=true`/`=false`); a name in
 * {@link ArgsSpec.string} consumes a value (`--name value` or `--name=value`).
 * Both lists are `readonly` so a spec can be a shared `as const` literal.
 *
 * @property boolean flag names parsed as booleans.
 * @property string flag names that take a string value.
 */
export interface ArgsSpec {
  boolean: readonly string[];

  string: readonly string[];
}

/**
 * The parsed result of {@link parseArgs}.
 *
 * @property flags every declared flag, keyed by name. Booleans are always
 *   present (defaulted to `false`); string flags appear only when supplied.
 * @property positionals non-flag tokens, in argv order. Scripts that take no
 *   positionals treat a non-empty array as a usage error.
 * @property unknown tokens that looked like flags but were not in the spec, or
 *   were malformed (e.g. a string flag with no value, a boolean given a
 *   non-`true`/`false` `=value`). Never throws — the caller decides what to do.
 * @property projectRoot the canonicalised project root: `--project-root` if a
 *   string was given, otherwise `process.cwd()`, always run through
 *   {@link canonicalizePath} so it is absolute and symlink-resolved.
 */
export interface ParsedScriptArgs {
  flags: Record<string, string | boolean>;

  positionals: string[];

  unknown: string[];

  projectRoot: string;
}

// Default spec used when a caller does not pass one: the flags common to
// every script. Scripts with extra flags pass their own widened spec instead.
const RECOGNISED_BOOLEANS = ['json', 'quiet', 'help'] as const;
const RECOGNISED_STRINGS = ['project-root'] as const;

/**
 * Parse a CLI argument vector against `spec`.
 *
 * Recognises three flag shapes: `--name` (boolean, sets `true`),
 * `--name=value` (boolean coerced from `'true'`/`'false'`, or string assigned
 * verbatim), and `--name value` (string flags only — consumes the next token
 * unless it is absent or itself starts with `--`). Anything unrecognised is
 * pushed to `unknown`; bare tokens become `positionals`.
 *
 * Never throws on malformed input: invalid flags are reported as data in
 * `unknown` so the caller can produce a script-specific usage message. The
 * only side effect is reading `process.cwd()` when `--project-root` is absent.
 *
 * @param argv the raw argument tokens (typically `process.argv.slice(2)`).
 * @param spec which flag names are booleans vs. strings; defaults to the
 *   common `json`/`quiet`/`help` + `project-root` set.
 * @returns the {@link ParsedScriptArgs}, with `projectRoot` always populated.
 */
export function parseArgs(
  argv: readonly string[],
  spec: ArgsSpec = { boolean: RECOGNISED_BOOLEANS, string: RECOGNISED_STRINGS },
): ParsedScriptArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];

  // Pre-seed every boolean to `false` so callers can read `flags[name]`
  // unconditionally without an `in`/undefined check; string flags are left
  // absent so a missing string is distinguishable from an empty value.
  for (const name of spec.boolean) {
    flags[name] = false;
  }

  // Manual index walk (not a for-of) because the `--key value` form must look
  // ahead and consume a second token, advancing `i` by 2.
  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;

    // Form 1: `--name=value`. Split on the first `=` so a value may itself
    // contain `=`. A boolean only accepts the literals true/false here;
    // anything else is malformed and reported rather than silently coerced.
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

    // Form 2: a bare `--name` (length > 2 excludes a lone `--`).
    if (token.startsWith('--') && token.length > 2) {
      const name = token.slice(2);
      if (spec.boolean.includes(name)) {
        flags[name] = true;
        i += 1;
        continue;
      }
      if (spec.string.includes(name)) {
        const next = argv[i + 1];
        // A string flag needs a value token. Treat a following `--`-token as a
        // new flag (not this flag's value), so `--out --json` reports `--out`
        // as unknown rather than swallowing `--json` as its argument.
        if (next === undefined || next.startsWith('--')) {
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

    // Anything not matching a flag shape is a positional argument.
    positionals.push(token);
    i += 1;
  }

  // `project-root` is special-cased into a derived field: fall back to the cwd
  // when unset, then canonicalise so downstream code always gets an absolute,
  // symlink-resolved root regardless of how the user expressed it.
  const projectRootRaw =
    typeof flags['project-root'] === 'string' ? (flags['project-root'] as string) : process.cwd();
  const projectRoot = canonicalizePath(projectRootRaw);

  return { flags, positionals, unknown, projectRoot };
}
