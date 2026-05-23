

import { canonicalizePath } from '../../src/config-server/determinism/index.js';

export interface ArgsSpec {

  boolean: readonly string[];

  string: readonly string[];
}

export interface ParsedScriptArgs {

  flags: Record<string, string | boolean>;

  positionals: string[];

  unknown: string[];

  projectRoot: string;
}

const RECOGNISED_BOOLEANS = ['json', 'quiet', 'help'] as const;
const RECOGNISED_STRINGS = ['project-root'] as const;

export function parseArgs(
  argv: readonly string[],
  spec: ArgsSpec = { boolean: RECOGNISED_BOOLEANS, string: RECOGNISED_STRINGS },
): ParsedScriptArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const unknown: string[] = [];

  for (const name of spec.boolean) {
    flags[name] = false;
  }

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;

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

    positionals.push(token);
    i += 1;
  }

  const projectRootRaw =
    typeof flags['project-root'] === 'string' ? (flags['project-root'] as string) : process.cwd();
  const projectRoot = canonicalizePath(projectRootRaw);

  return { flags, positionals, unknown, projectRoot };
}
