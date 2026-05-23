#!/usr/bin/env -S node --no-warnings

/**
 * Entry point and command router for the `gan` CLI.
 *
 * This module wires the whole binary together: it parses the top-level argv,
 * routes the first positional to a top-level subcommand, and — for the grouped
 * commands (`config`, `stacks`, `stack`, `modules`, `hooks`, `trust`) — routes
 * the second positional to the right inner command. Each command module owns
 * its own logic; this file only decides *who* runs and threads the parsed args
 * to them.
 *
 * Shared conventions across the dispatchers below:
 * - Every group dispatcher peels the group name off `parsed._` and forwards a
 *   `tail` whose `_` is shifted by one, so each inner command sees its own
 *   positionals starting at index 0 (while `flags`/`doubleDashSeen` pass
 *   through unchanged).
 * - A missing inner subcommand and an unknown one are distinct, deliberate
 *   outcomes: both return `EXIT_BAD_ARGS`, but with different guidance text
 *   (which subcommands exist vs. that the given one is unknown).
 * - Dispatchers return a {@link CommandResult} (stdout/stderr/code); they never
 *   write to the streams or exit. Only {@link dispatch}/{@link main} do that,
 *   which keeps the routing layer testable.
 */

import * as helpCmd from './commands/help.js';
import * as versionCmd from './commands/version.js';
import * as configPrintCmd from './commands/config-print.js';
import * as configGetCmd from './commands/config-get.js';
import * as configSetCmd from './commands/config-set.js';
import * as stacksAvailableCmd from './commands/stacks-available.js';
import * as stacksCustomizeCmd from './commands/stacks-customize.js';
import * as stacksListCmd from './commands/stacks-list.js';
import * as stacksNewCmd from './commands/stacks-new.js';
import * as stacksResetCmd from './commands/stacks-reset.js';
import * as stacksWhereCmd from './commands/stacks-where.js';
import * as stackShowCmd from './commands/stack-show.js';
import * as stackUpdateCmd from './commands/stack-update.js';
import * as modulesListCmd from './commands/modules-list.js';
import * as hooksStatusCmd from './commands/hooks-status.js';
import * as validateCmd from './commands/validate.js';
import * as trustInfoCmd from './commands/trust-info.js';
import * as trustApproveCmd from './commands/trust-approve.js';
import * as trustRevokeCmd from './commands/trust-revoke.js';
import * as trustListCmd from './commands/trust-list.js';
import { GLOBAL_FLAGS, parseArgs, type CommandSpec, type ParsedArgs } from './lib/args.js';
import { renderTopLevelHelp } from './lib/help.js';
import { writeErr, writeOut } from './lib/output.js';
import { EXIT_BAD_ARGS, EXIT_OK } from './lib/exit-codes.js';

/**
 * The uniform result a command (or dispatcher) returns to {@link dispatch}:
 * text for stdout, text for stderr, and the process exit code.
 */
interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * A routable command: takes the parsed args (already shifted to its own
 * positional frame) and resolves to a {@link CommandResult}. Both leaf commands
 * and the group dispatchers below conform to this signature.
 */
type Subcommand = (parsed: ParsedArgs) => Promise<CommandResult>;

/**
 * Route `gan config <print|get|set>` to its inner command.
 *
 * @param parsed args whose `_[0]` is the inner subcommand name.
 * @returns the inner command's result; an absent `_[0]` returns a
 *   "requires a subcommand" usage error and an unrecognised one an "unknown
 *   subcommand" error — both with `EXIT_BAD_ARGS`.
 */
async function configDispatch(parsed: ParsedArgs): Promise<CommandResult> {
  const inner = parsed._[0];
  // Shift the positional frame down one so the inner command sees its own args
  // at index 0; flags and the `--` marker are shared and pass through unchanged.
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
      return configSetCmd.run(tail);
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

/**
 * Route `gan stacks <list|new|available|customize|reset|where>` to its inner
 * command. Same frame-shift and missing/unknown-subcommand contract as
 * {@link configDispatch}.
 */
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
      return stacksNewCmd.run(tail);
    case 'available':
      return stacksAvailableCmd.run(tail);
    case 'customize':
      return stacksCustomizeCmd.run(tail);
    case 'reset':
      return stacksResetCmd.run(tail);
    case 'where':
      return stacksWhereCmd.run(tail);
    case undefined:
      return {
        stdout: '',
        stderr:
          'Error: gan stacks requires a subcommand (`list`, `new`, `available`, `customize`, `reset`, or `where`). Run `gan stacks --help`.\n',
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

/**
 * Route `gan stack <show|update>` to its inner command. Singular `stack`
 * (operates on one named stack file), distinct from the plural `stacks` group.
 * Same frame-shift and missing/unknown-subcommand contract as
 * {@link configDispatch}.
 */
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
      return stackUpdateCmd.run(tail);
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

/**
 * Route `gan modules <list>` to its inner command. Same frame-shift and
 * missing/unknown-subcommand contract as {@link configDispatch}; currently only
 * `list` is defined.
 */
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
 * Route `gan hooks <status>` to its inner command. Same frame-shift and
 * missing/unknown-subcommand contract as {@link configDispatch}; currently only
 * `status` is defined.
 */
async function hooksDispatch(parsed: ParsedArgs): Promise<CommandResult> {
  const inner = parsed._[0];
  const tail: ParsedArgs = {
    _: parsed._.slice(1),
    flags: parsed.flags,
    doubleDashSeen: parsed.doubleDashSeen,
  };
  switch (inner) {
    case 'status':
      return hooksStatusCmd.run(tail);
    case undefined:
      return {
        stdout: '',
        stderr: 'Error: gan hooks requires a subcommand (`status`). Run `gan hooks --help`.\n',
        code: EXIT_BAD_ARGS,
      };
    default:
      return {
        stdout: '',
        stderr: `Error: unknown subcommand 'gan hooks ${inner}'. Run \`gan hooks --help\` for usage.\n`,
        code: EXIT_BAD_ARGS,
      };
  }
}

/**
 * Route `gan trust <info|approve|revoke|list>` to its inner command. Same
 * frame-shift and missing/unknown-subcommand contract as {@link configDispatch}.
 */
async function trustDispatch(parsed: ParsedArgs): Promise<CommandResult> {
  const inner = parsed._[0];
  const tail: ParsedArgs = {
    _: parsed._.slice(1),
    flags: parsed.flags,
    doubleDashSeen: parsed.doubleDashSeen,
  };
  switch (inner) {
    case 'info':
      return trustInfoCmd.run(tail);
    case 'approve':
      return trustApproveCmd.run(tail);
    case 'revoke':
      return trustRevokeCmd.run(tail);
    case 'list':
      return trustListCmd.run(tail);
    case undefined:
      return {
        stdout: '',
        stderr:
          'Error: gan trust requires a subcommand (`info`, `approve`, `revoke`, or `list`). Run `gan trust --help`.\n',
        code: EXIT_BAD_ARGS,
      };
    default:
      return {
        stdout: '',
        stderr: `Error: unknown subcommand 'gan trust ${inner}'. Run \`gan trust --help\` for usage.\n`,
        code: EXIT_BAD_ARGS,
      };
  }
}

/**
 * The top-level dispatch table: subcommand name → handler. Leaf commands map
 * to a command module's `run`; grouped commands map to a group dispatcher
 * above. Frozen so the routing table cannot be mutated at runtime; this is the
 * authority for what `gan <name>` actually runs (the help copy is separate).
 */
const SUBCOMMANDS: Readonly<Record<string, Subcommand>> = Object.freeze({
  version: versionCmd.run,
  help: helpCmd.run,
  validate: validateCmd.run,
  config: configDispatch,
  stacks: stacksDispatch,
  stack: stackDispatch,
  modules: modulesDispatch,
  hooks: hooksDispatch,
  trust: trustDispatch,
});

// Flag spec used to parse the *top-level* argv. It must list every flag any
// subcommand accepts (--tier/--note/--force alongside the globals) because the
// whole argv is parsed once here with allowUnknownFlags:false; a flag missing
// from this list would be rejected before its command ever runs. The shared
// `flags` object is then threaded down to the chosen command.
const TOP_LEVEL_SPEC: CommandSpec = {
  flags: [
    ...GLOBAL_FLAGS,

    { long: '--tier', type: 'string' },

    { long: '--note', type: 'string' },

    { long: '--force', type: 'boolean' },
  ],
  allowUnknownFlags: false,
};

/**
 * Translate a parse failure into an exit code, emitting its message to stderr.
 *
 * @param parsed the parsed args, possibly carrying `.error`.
 * @returns `EXIT_OK` when there was no parse error (nothing is written), else
 *   `EXIT_BAD_ARGS` after writing the error and a usage hint to stderr.
 */
function emitParseError(parsed: ParsedArgs): number {
  if (!parsed.error) return EXIT_OK;
  writeErr(`Error: ${parsed.error.message}\n`);
  writeErr('Run `gan --help` for usage.\n');
  return EXIT_BAD_ARGS;
}

// True when `--help`/`-h` was supplied. Used both to short-circuit to
// top-level help and to redirect a `gan <sub> --help` into the help command.
function isHelpRequest(parsed: ParsedArgs): boolean {
  return parsed.flags['help'] === true;
}

/**
 * Parse the argv, pick the subcommand, run it, and write its output.
 *
 * This is the routing core, separated from {@link main} so it can be exercised
 * in tests without spawning a process or calling `process.exit`. It writes the
 * chosen command's stdout/stderr to the real streams and returns the exit code
 * for the caller to act on.
 *
 * Routing order (each step is a deliberate early return):
 * 1. empty argv → top-level help;
 * 2. a parse error → {@link emitParseError};
 * 3. `--help` with no subcommand → top-level help;
 * 4. no subcommand token → top-level help;
 * 5. an unknown subcommand → `EXIT_BAD_ARGS` with guidance;
 * 6. `--help` with a known subcommand → that subcommand's help page;
 * 7. otherwise → run the subcommand on its shifted args.
 *
 * @param rawArgv the arguments after the node binary and script (i.e.
 *   `process.argv.slice(2)`), passed explicitly so tests can supply their own.
 * @returns the process exit code; does not call `process.exit` itself.
 */
export async function dispatch(rawArgv: readonly string[]): Promise<number> {

  if (rawArgv.length === 0) {
    writeOut(renderTopLevelHelp());
    return EXIT_OK;
  }

  const parsed = parseArgs(rawArgv, TOP_LEVEL_SPEC);
  if (parsed.error) {
    return emitParseError(parsed);
  }

  // `gan --help` (no subcommand) shows the menu; `gan <sub> --help` is handled
  // below, after the subcommand is identified, so it can show that page.
  if (isHelpRequest(parsed) && parsed._.length === 0) {
    writeOut(renderTopLevelHelp());
    return EXIT_OK;
  }

  const subName = parsed._[0];

  if (subName === undefined) {

    writeOut(renderTopLevelHelp());
    return EXIT_OK;
  }

  const sub = SUBCOMMANDS[subName];
  if (!sub) {
    writeErr(`Error: unknown subcommand '${subName}'.\n`);
    writeErr('Run `gan --help` for the subcommand list.\n');
    return EXIT_BAD_ARGS;
  }

  // `gan <sub> --help`: render that subcommand's help page rather than running
  // it. The help command is invoked with the subcommand name as its sole
  // positional and an empty flag set, so the request flags don't leak into it.
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

  // Run the chosen command on its own positional frame (subcommand name
  // dropped), sharing the parsed flags and `--` marker.
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
 * Process entry point: run {@link dispatch} on the real argv and exit with its
 * code.
 *
 * Side effect: terminates the process via `process.exit`, so it never returns
 * normally despite the `Promise<void>` type. A rejection is handled by the
 * `.catch` on the call below, not here.
 */
export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await dispatch(argv);
  process.exit(code);
}

// Top-level safety net: any error that escapes dispatch/main (an unexpected
// throw, not a normal command failure, which returns a code) is printed as a
// fatal message and the process exits 1. This is the last line of defense so
// the CLI never crashes with an unhandled-rejection stack trace.
main().catch((e) => {
  writeErr(`gan: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
