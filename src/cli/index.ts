#!/usr/bin/env -S node --no-warnings

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

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

type Subcommand = (parsed: ParsedArgs) => Promise<CommandResult>;

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

const TOP_LEVEL_SPEC: CommandSpec = {
  flags: [
    ...GLOBAL_FLAGS,

    { long: '--tier', type: 'string' },

    { long: '--note', type: 'string' },

    { long: '--force', type: 'boolean' },
  ],
  allowUnknownFlags: false,
};

function emitParseError(parsed: ParsedArgs): number {
  if (!parsed.error) return EXIT_OK;
  writeErr(`Error: ${parsed.error.message}\n`);
  writeErr('Run `gan --help` for usage.\n');
  return EXIT_BAD_ARGS;
}

function isHelpRequest(parsed: ParsedArgs): boolean {
  return parsed.flags['help'] === true;
}

export async function dispatch(rawArgv: readonly string[]): Promise<number> {

  if (rawArgv.length === 0) {
    writeOut(renderTopLevelHelp());
    return EXIT_OK;
  }

  const parsed = parseArgs(rawArgv, TOP_LEVEL_SPEC);
  if (parsed.error) {
    return emitParseError(parsed);
  }

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

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const code = await dispatch(argv);
  process.exit(code);
}

main().catch((e) => {
  writeErr(`gan: fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
