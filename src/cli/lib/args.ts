

export interface FlagSpec {

  long: string;

  short?: string;

  type: 'boolean' | 'string';

  defaultValue?: string | boolean;
}

export interface CommandSpec {

  flags: readonly FlagSpec[];

  allowUnknownFlags?: boolean;
}

export interface ParsedArgs {

  _: string[];

  flags: Record<string, string | boolean>;

  doubleDashSeen: boolean;

  error?: ParseError;
}

export interface ParseError {

  kind: 'unknown-flag' | 'missing-value';

  flag: string;

  message: string;
}

function findFlag(spec: CommandSpec, token: string): FlagSpec | undefined {
  return spec.flags.find((f) => f.long === token || f.short === token);
}

export function parseArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs {
  const out: ParsedArgs = {
    _: [],
    flags: {},
    doubleDashSeen: false,
  };

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

      for (let j = i + 1; j < argv.length; j += 1) {
        out._.push(argv[j]!);
      }
      break;
    }

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

function stripLong(long: string): string {
  return long.startsWith('--') ? long.slice(2) : long;
}

export const GLOBAL_FLAGS: readonly FlagSpec[] = Object.freeze([
  Object.freeze({ long: '--help', short: '-h', type: 'boolean' as const }),
  Object.freeze({ long: '--json', type: 'boolean' as const }),
  Object.freeze({ long: '--project-root', type: 'string' as const }),
]);
