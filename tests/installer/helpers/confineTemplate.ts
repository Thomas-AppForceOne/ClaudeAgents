import { readFileSync } from 'node:fs';
import path from 'node:path';
import { repoRootDir } from './spawn.js';

/** Render the source-of-truth confine-hook template for the running framework version. */
export function renderedTemplate(): string {
  const root = repoRootDir();
  const version = (
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const tpl = readFileSync(
    path.join(root, 'scripts', 'hooks', 'gan-confine.sh.template'),
    'utf8',
  );
  return tpl.split('__GAN_FRAMEWORK_VERSION__').join(version);
}
