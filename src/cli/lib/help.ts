/**
 * R3 sprint 1 — help-text registry.
 *
 * Per the R3-locked help-output rule (PROJECT_CONTEXT.md): all help goes
 * to stdout and exits 0; help text never references maintainer-only
 * scripts and obeys the F4 prose discipline (no bare `npm`, `node`,
 * `Node`, or `MCP server` outside backticks).
 *
 * 80-col hard wrap, no ANSI color, R2 `install.sh --help` style: usage
 * line, flag/subcommand block, examples, exit codes.
 *
 * Subcommands that ship in S2-S4 already have help entries here so the
 * help surface is complete from S1 onward — a `gan stacks list --help`
 * works even though `gan stacks list` itself is a stub. This satisfies
 * F-AC8 (per-subcommand help) up front and keeps the prose-discipline
 * test honest across the whole help surface.
 */

const HEADER = `gan — ClaudeAgents configuration tool`;

const SKILL_VS_CLI =
  `Note: to run a sprint, use the /gan skill in Claude Code; this CLI ` +
  `manages configuration only.`;

/** Subcommand names in the order they appear in help output. */
export const SUBCOMMAND_NAMES: readonly string[] = Object.freeze([
  'version',
  'validate',
  'config',
  'stacks',
  'stack',
  'modules',
  'trust',
  'help',
]);

/** One-line description per top-level subcommand. */
const SUBCOMMAND_SUMMARY: Readonly<Record<string, string>> = Object.freeze({
  version: 'Print API version, framework version, and on-disk schemas.',
  validate: 'Run validateAll() and print a structured report.',
  config: 'Print, get, or set resolved-config splice points.',
  stacks: 'List active stacks or scaffold a new stack file.',
  stack: 'Show or update a single stack file.',
  modules: 'List registered modules with pairing status.',
  trust: 'Approve, revoke, or inspect project trust-cache approvals.',
  help: 'Show help for a subcommand.',
});

/**
 * Lines printed for the global flag block. Used both by the top-level
 * help and by subcommand help.
 */
const GLOBAL_FLAGS_BLOCK: readonly string[] = Object.freeze([
  '  -h, --help              Show this help and exit.',
  '      --json              Emit JSON on stdout (read subcommands only).',
  '      --project-root DIR  Project root for resolution (default: cwd).',
]);

const EXIT_CODES_BLOCK: readonly string[] = Object.freeze([
  '  0   Success',
  '  1   Generic failure',
  '  2   Validation failure (report on stdout)',
  '  3   Schema mismatch',
  '  4   Invariant violation',
  '  5   Framework library unreachable (run `install.sh` from the repo root)',
  '  64  Bad CLI arguments',
]);

/**
 * Render the top-level `gan --help` body. Always written to stdout, exit
 * 0. The contract in R3 spec acceptance criteria requires that this
 * surface lists every subcommand and mentions every global flag.
 */
export function renderTopLevelHelp(): string {
  const lines: string[] = [];
  lines.push(HEADER);
  lines.push('');
  lines.push(SKILL_VS_CLI);
  lines.push('');
  lines.push('Usage:');
  lines.push('  gan <subcommand> [flags]');
  lines.push('  gan --help');
  lines.push('  gan <subcommand> --help');
  lines.push('');
  lines.push('Subcommands:');
  for (const name of SUBCOMMAND_NAMES) {
    const summary = SUBCOMMAND_SUMMARY[name] ?? '';
    lines.push(`  ${name.padEnd(10)} ${summary}`);
  }
  lines.push('');
  lines.push('Global flags:');
  for (const f of GLOBAL_FLAGS_BLOCK) lines.push(f);
  lines.push('');
  lines.push('Exit codes:');
  for (const c of EXIT_CODES_BLOCK) lines.push(c);
  lines.push('');
  lines.push('Run `gan <subcommand> --help` for per-subcommand details.');
  lines.push('');
  return lines.join('\n');
}

interface SubcommandHelp {
  usage: string;
  description: string;
  flags?: readonly string[];
  examples: readonly string[];
  /** Subset of exit codes relevant to this subcommand. */
  exitCodes: readonly string[];
}

const SUBCOMMAND_HELP: Readonly<Record<string, SubcommandHelp>> = Object.freeze({
  version: {
    usage: 'gan version [--json]',
    description:
      'Print the API version, the installed framework version, and the on-disk\n' +
      'schemas (one row per `schemas/<type>-vN.json`).',
    flags: ['      --json   Emit JSON on stdout.'],
    examples: ['  gan version', '  gan version --json'],
    exitCodes: ['  0  Success', '  5  Framework library unreachable'],
  },
  validate: {
    usage: 'gan validate [--json] [--project-root DIR]',
    description:
      'Run validateAll() against the project and print a structured report.\n' +
      'Exits 2 when validation fails; the report is on stdout in either case.',
    examples: ['  gan validate', '  gan validate --json'],
    exitCodes: [
      '  0   Success',
      '  2   Validation failure',
      '  3   Schema mismatch',
      '  4   Invariant violation',
      '  5   Framework library unreachable',
    ],
  },
  config: {
    usage: 'gan config <print|get|set> [args] [--json] [--project-root DIR]',
    description:
      'Print, get, or set resolved-config splice points.\n' +
      '  gan config print              Print the full resolved config.\n' +
      '  gan config get <path>         Print one resolved value.\n' +
      '  gan config set <path> <value> [--tier=project|user]',
    examples: [
      '  gan config print --json',
      '  gan config get runner.thresholdOverride',
      '  gan config set runner.thresholdOverride 8 --tier=project',
    ],
    exitCodes: [
      '  0   Success',
      '  2   Validation failure',
      '  5   Framework library unreachable',
      '  64  Bad CLI arguments',
    ],
  },
  stacks: {
    usage: 'gan stacks <list|new> [args] [--json] [--project-root DIR]',
    description:
      'List active stacks or scaffold a new stack file.\n' +
      '  gan stacks list                       List active stacks.\n' +
      '  gan stacks new <name> [--tier=project|repo]\n' +
      '                                        Scaffold a stack file.',
    flags: ['      --tier=project|repo   Where to scaffold (default: project).'],
    examples: [
      '  gan stacks list',
      '  gan stacks new ios',
      '  gan stacks new web-rust --tier=repo',
    ],
    exitCodes: [
      '  0   Success',
      '  1   Generic failure (target file already exists)',
      '  64  Bad CLI arguments',
    ],
  },
  stack: {
    usage: 'gan stack <show|update> <name> [args] [--json] [--project-root DIR]',
    description:
      'Show or update a single stack file.\n' +
      '  gan stack show <name>                       Print one stack.\n' +
      '  gan stack update <name> <field> <value>     Update one field.',
    examples: ['  gan stack show generic', '  gan stack update generic testCmd "vitest run"'],
    exitCodes: [
      '  0   Success',
      '  2   Validation failure',
      '  5   Framework library unreachable',
      '  64  Bad CLI arguments',
    ],
  },
  modules: {
    usage: 'gan modules list [--json] [--project-root DIR]',
    description: 'List registered modules with their pairing status.',
    examples: ['  gan modules list', '  gan modules list --json'],
    exitCodes: ['  0   Success', '  5   Framework library unreachable'],
  },
  trust: {
    usage: 'gan trust <info|approve|revoke|list> [args] [--json]',
    description:
      'Manage the project trust cache.\n' +
      '  gan trust info    [--project-root DIR]   Show approval state for a project.\n' +
      '  gan trust approve  --project-root DIR    Approve current overlay contents.\n' +
      '  gan trust revoke   --project-root DIR    Revoke approvals for a project.\n' +
      '  gan trust list                           List every recorded approval.',
    flags: ['      --note TEXT   Optional note attached to an approve record.'],
    examples: [
      '  gan trust info --project-root /path/to/project',
      '  gan trust approve --project-root /path/to/project --note "reviewed in PR #42"',
      '  gan trust list --json',
      '  gan trust revoke --project-root /path/to/project',
    ],
    exitCodes: [
      '  0   Success',
      '  1   Generic failure (e.g. trust-cache file unreadable)',
      '  64  Bad CLI arguments (missing --project-root for approve/revoke)',
    ],
  },
  'trust info': {
    usage: 'gan trust info [--project-root DIR] [--json]',
    description:
      'Show whether the current project overlay contents are approved in\n' +
      'the user-tier trust cache. Defaults --project-root to the canonical\n' +
      'form of the current working directory.',
    examples: [
      '  gan trust info',
      '  gan trust info --project-root /path/to/project',
      '  gan trust info --json',
    ],
    exitCodes: ['  0   Success', '  1   Generic failure'],
  },
  'trust approve': {
    usage: 'gan trust approve --project-root DIR [--note TEXT] [--json]',
    description:
      'Approve the current overlay contents for the named project. The\n' +
      'aggregate hash is recomputed from disk; the supplied --note is\n' +
      'stored verbatim alongside the approval record.',
    flags: ['      --note TEXT   Optional note stored alongside the record.'],
    examples: [
      '  gan trust approve --project-root /path/to/project',
      '  gan trust approve --project-root /path/to/project --note "PR #42"',
    ],
    exitCodes: [
      '  0   Success',
      '  1   Generic failure',
      '  64  Bad CLI arguments (missing --project-root)',
    ],
  },
  'trust revoke': {
    usage: 'gan trust revoke --project-root DIR [--json]',
    description: 'Remove every approval for the named project from the user-tier trust cache.',
    examples: ['  gan trust revoke --project-root /path/to/project'],
    exitCodes: [
      '  0   Success',
      '  1   Generic failure',
      '  64  Bad CLI arguments (missing --project-root)',
    ],
  },
  'trust list': {
    usage: 'gan trust list [--json]',
    description: 'List every approval recorded in the user-tier trust cache.',
    examples: ['  gan trust list', '  gan trust list --json'],
    exitCodes: ['  0   Success', '  1   Generic failure'],
  },
  help: {
    usage: 'gan help [<subcommand>]',
    description:
      'Show top-level help, or per-subcommand help when a name is given.\n' +
      'Equivalent to `gan --help` and `gan <subcommand> --help`.',
    examples: ['  gan help', '  gan help version'],
    exitCodes: ['  0   Success'],
  },
});

/**
 * Render per-subcommand help. If the name is unknown, the function returns
 * the top-level help body (callers should treat unknown names as a
 * dispatcher-level concern; the help renderer is forgiving here so the
 * `help` subcommand and the bare `--help` paths both stay non-fatal).
 */
export function renderSubcommandHelp(name: string): string {
  const entry = SUBCOMMAND_HELP[name];
  if (!entry) {
    return renderTopLevelHelp();
  }

  const lines: string[] = [];
  lines.push(`gan ${name} — ${SUBCOMMAND_SUMMARY[name] ?? ''}`);
  lines.push('');
  lines.push('Usage:');
  lines.push(`  ${entry.usage}`);
  lines.push('');
  lines.push(entry.description);
  lines.push('');
  if (entry.flags && entry.flags.length > 0) {
    lines.push('Flags:');
    for (const f of entry.flags) lines.push(f);
    lines.push('');
  }
  lines.push('Global flags:');
  for (const f of GLOBAL_FLAGS_BLOCK) lines.push(f);
  lines.push('');
  lines.push('Examples:');
  for (const e of entry.examples) lines.push(e);
  lines.push('');
  lines.push('Exit codes:');
  for (const c of entry.exitCodes) lines.push(c);
  lines.push('');
  return lines.join('\n');
}

/** Public list of subcommand names that have a help entry. */
export function subcommandHelpNames(): readonly string[] {
  return Object.freeze(Object.keys(SUBCOMMAND_HELP).slice());
}
