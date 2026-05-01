#!/usr/bin/env -S node --no-warnings
/**
 * R3 sprint 1 — `gan` bin entry.
 *
 * Architecture (per PROJECT_CONTEXT.md, R3-locked):
 *   - In-process library import; never spawns the framework's server.
 *   - Bespoke arg parser (no new deps).
 *   - One exit-code map (`lib/exit-codes.ts`).
 *   - Help output always to stdout, exit 0.
 *   - Unknown subcommand / unknown flag → exit 64 with a `--help` pointer.
 *
 * The shebang passes `--no-warnings` to the runtime so success-path stderr
 * stays empty. The framework's library (R1) imports JSON Schema documents
 * via `import … with { type: 'json' }`, which emits an
 * `ExperimentalWarning` on every load. The warning is harmless and the
 * import form is stable on every supported runtime version, but the noise
 * would break the R3-locked help-output contract ("help to stdout, nothing
 * on stderr"). Suppressing the warning category at the runtime flag level
 * is the only reliable fix — listener-based suppression does not work for
 * the JSON-import warning.
 *
 * S1 wires version, help, and a stub arm for every other subcommand. The
 * stub arms land their real backends in S2-S4 (and `trust` in R5).
 */

import * as helpCmd from './commands/help.js';
import * as versionCmd from './commands/version.js';
import * as configPrintCmd from './commands/config-print.js';
import * as configGetCmd from './commands/config-get.js';
import * as stacksListCmd from './commands/stacks-list.js';
import * as stackShowCmd from './commands/stack-show.js';
import * as modulesListCmd from './commands/modules-list.js';
import { makeNotYetStub, trustStub } from './commands/_stubs.js';
import { GLOBAL_FLAGS, parseArgs, type CommandSpec, type ParsedArgs } from './lib/args.js';
import { renderTopLevelHelp } from './lib/help.js';
import { writeErr, writeOut } from './lib/output.js';
import { EXIT_BAD_ARGS, EXIT_OK } from './lib/exit-codes.js';

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Subcommand = (parsed: ParsedArgs) => Promise<CommandResult>;

/**
 * Inner dispatch for `gan config <print|get|set>`. The S2 read arms are
 * real; `set` remains a stub until S3.
 */
async function configDispatch(parsed: ParsedArgs): Promise<CommandResult> {
  const inner = parsed._[0];
  const tail: ParsedArgs = {
    _: parsed._.slice(1),
    flags: parsed.flags,
    doubleDashSeen: parsed.doubleDashSeen,
  };
  switch (inner) {
    case 'print':
      return configPrintCmd.run(tail);
    case 'get':
      return configGetCmd.run(tail);
    case 'set':
      return makeNotYetStub('gan config set')(tail);
    case undefined:
      return {
        stdout: '',
        stderr:
          'Error: gan config requires a subcommand (`print`, `get`, or `set`). Run `gan config --help`.\n',
        code: EXIT_BAD_ARGS,
      };
    default:
      return {
        stdout: '',
        stderr: `Error: unknown subcommand 'gan config ${inner}'. Run \`gan config --help\` for usage.\n`,
        code: EXIT_BAD_ARGS,
      };
  }
}

/** Inner dispatch for `gan stacks <list|new>`. `new` ships in S4. */
async function stacksDispatch(parsed: ParsedArgs): Promise<CommandResult> {
  const inner = parsed._[0];
  const tail: ParsedArgs = {
    _: parsed._.slice(1),
    flags: parsed.flags,
    doubleDashSeen: parsed.doubleDashSeen,
  };
  switch (inner) {
    case 'list':
      return stacksListCmd.run(tail);
    case 'new':
      return makeNotYetStub('gan stacks new')(tail);
    case undefined:
      return {
        stdout: '',
        stderr:
          'Error: gan stacks requires a subcommand (`list` or `new`). Run `gan stacks --help`.\n',
        code: EXIT_BAD_ARGS,
      };
    default:
      return {
        stdout: '',
        stderr: `Error: unknown subcommand 'gan stacks ${inner}'. Run \`gan stacks --help\` for usage.\n`,
        code: EXIT_BAD_ARGS,
      };
  }
}

/** Inner dispatch for `gan stack <show|update> <name>`. `update` ships in S3. */
async function stackDispatch(parsed: ParsedArgs): Promise<CommandResult> {
  const inner = parsed._[0];
  const tail: ParsedArgs = {
    _: parsed._.slice(1),
    flags: parsed.flags,
    doubleDashSeen: parsed.doubleDashSeen,
  };
  switch (inner) {
    case 'show':
      return stackShowCmd.run(tail);
    case 'update':
      return makeNotYetStub('gan stack update')(tail);
    case undefined:
      return {
        stdout: '',
        stderr:
          'Error: gan stack requires a subcommand (`show` or `update`). Run `gan stack --help`.\n',
        code: EXIT_BAD_ARGS,
      };
    default:
      return {
        stdout: '',
        stderr: `Error: unknown subcommand 'gan stack ${inner}'. Run \`gan stack --help\` for usage.\n`,
        code: EXIT_BAD_ARGS,
      };
  }
}

/** Inner dispatch for `gan modules list`. The only S2 arm. */
async function modulesDispatch(parsed: ParsedArgs): Promise<CommandResult> {
  const inner = parsed._[0];
  const tail: ParsedArgs = {
    _: parsed._.slice(1),
    flags: parsed.flags,
    doubleDashSeen: parsed.doubleDashSeen,
  };
  switch (inner) {
    case 'list':
      return modulesListCmd.run(tail);
    case undefined:
      return {
        stdout: '',
        stderr: 'Error: gan modules requires a subcommand (`list`). Run `gan modules --help`.\n',
        code: EXIT_BAD_ARGS,
      };
    default:
      return {
        stdout: '',
        stderr: `Error: unknown subcommand 'gan modules ${inner}'. Run \`gan modules --help\` for usage.\n`,
        code: EXIT_BAD_ARGS,
      };
  }
}

/**
 * Top-level subcommand registry. Subcommands that themselves dispatch on
 * a second positional (`gan config print|get|set`, etc.) keep the inner
 * dispatch in a `*Dispatch` helper above so this table stays a single
 * lookup of name → handler.
 *
 * Keys are the canonical subcommand names from the R3 spec's surface
 * table. The dispatcher hands the parsed args to the matched function;
 * the function returns `{ stdout, stderr, code }` and the dispatcher
 * writes them.
 */
const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = Object.freeze({
  version: versionCmd.run,
  help: helpCmd.run,
  validate: makeNotYetStub('gan validate'),
  config: configDispatch,
  stacks: stacksDispatch,
  stack: stackDispatch,
  modules: modulesDispatch,
  trust: trustStub,
});

/**
 * Top-level command spec. We accept the global flags here; subcommand-
 * specific flags will be re-parsed by the subcommand once the dispatcher
 * has identified it. Keeping unknown flags as errors at this layer is
 * how F-AC9 (unknown-flag exit 64) gets enforced.
 *
 * `--tier` is allowed at the top level for ergonomics with the stub
 * arms; subcommands that do not consume it simply ignore it. We mark
 * unknown flags as allowed in the *first* parse only when the subcommand
 * has not yet been identified, so we can re-parse with the subcommand's
 * own spec downstream. For S1 there are no per-subcommand specs that
 * differ from the global set, so we keep the parse strict.
 */
const TOP_LEVEL_SPEC: CommandSpec = {
  flags: [
    ...GLOBAL_FLAGS,
    // `--tier` is referenced by `gan stacks new` and `gan config set`;
    // those are stubs in S1. We surface it here so it doesn't trigger
    // unknown-flag errors when callers run `gan stacks new ios --tier=project`.
    { long: '--tier', type: 'string' },
  ],
  allowUnknownFlags: false,
};

/** Pretty-print an unknown-flag / missing-value error to stderr. */
function emitParseError(parsed: ParsedArgs): number {
  if (!parsed.error) return EXIT_OK;
  writeErr(`Error: ${parsed.error.message}\n`);
  writeErr('Run `gan --help` for usage.\n');
  return EXIT_BAD_ARGS;
}

function isHelpRequest(parsed: ParsedArgs): boolean {
  return parsed.flags['help'] === true;
}

/**
 * Dispatch on argv and produce an exit code. Side effects are scoped to
 * `writeOut` / `writeErr`; the function does not call `process.exit`
 * directly — `main` does, so tests can call `dispatch` if they need to.
 */
export async function dispatch(rawArgv: readonly string[]): Promise<number> {
  // Bare `gan` with no arguments → top-level help, exit 0.
  if (rawArgv.length === 0) {
    writeOut(renderTopLevelHelp());
    return EXIT_OK;
  }

  const parsed = parseArgs(rawArgv, TOP_LEVEL_SPEC);
  if (parsed.error) {
    return emitParseError(parsed);
  }

  // `gan --help` / `gan -h` → top-level help, exit 0. `--json` is ignored
  // on help paths per the R3-locked help-output rule.
  if (isHelpRequest(parsed) && parsed._.length === 0) {
    writeOut(renderTopLevelHelp());
    return EXIT_OK;
  }

  const subName = parsed._[0];

  if (subName === undefined) {
    // Defensive: parse succeeded with no positional and no --help (e.g.
    // only --json was supplied). Treat as bare invocation → top-level
    // help.
    writeOut(renderTopLevelHelp());
    return EXIT_OK;
  }

  const sub = SUBCOMMANDS[subName];
  if (!sub) {
    writeErr(`Error: unknown subcommand '${subName}'.\n`);
    writeErr('Run `gan --help` for the subcommand list.\n');
    return EXIT_BAD_ARGS;
  }

  // `gan <sub> --help` (or `-h`) → per-subcommand help via the help command.
  if (isHelpRequest(parsed)) {
    const result = await helpCmd.run({
      _: [subName],
      flags: {},
      doubleDashSeen: false,
    });
    if (result.stdout) writeOut(result.stdout);
    if (result.stderr) writeErr(result.stderr);
    return result.code;
  }

  // Hand off to the subcommand. For S1 each subcommand re-uses the
  // already-parsed argv (positional tail + flags); the stubs ignore it.
  const subParsed: ParsedArgs = {
    _: parsed._.slice(1),
    flags: parsed.flags,
    doubleDashSeen: parsed.doubleDashSeen,
  };

  const result = await sub(subParsed);
  if (result.stdout) writeOut(result.stdout);
  if (result.stderr) writeErr(result.stderr);
  return result.code;
}

/**
 * Bin entry. We test the file by invoking its compiled output via
 * `child_process.spawn`, so this code path only runs when the file is the
 * bin target — which is also the default when the file is the process's
 * argv[1].
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await dispatch(argv);
  process.exit(code);
}

// Run when invoked as a bin (the shebang above ensures Node executes us).
// We deliberately do NOT gate on `import.meta.url === fileURLToPath(argv[1])`
// here because the build emits a single self-contained bin script. Tests
// invoke the compiled output via `node dist/cli/index.js`.
main().catch((e) => {
  writeErr(`gan: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
