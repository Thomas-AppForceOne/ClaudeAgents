

export function writeOut(s: string): void {
  process.stdout.write(s);
}

export function writeErr(s: string): void {
  process.stderr.write(s);
}

export interface WriteResultRenderInput {

  tier: 'project' | 'user';

  name?: string;

  path: string;

  value: unknown;
}

export function renderWriteResult(input: WriteResultRenderInput): string {
  const compact = JSON.stringify(input.value);
  if (input.name === undefined) {
    return `Updated \`${input.path}\` to \`${compact}\` in ${input.tier} overlay.\n`;
  }
  return `Updated \`${input.path}\` on stack \`${input.name}\` to \`${compact}\`.\n`;
}
