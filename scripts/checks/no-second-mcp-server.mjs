#!/usr/bin/env node
/*
 * Regression check: no second MCP server is registered, and the package
 * version stays on 0.1.0 (the bump is sprint 6 work). Loads ./package.json
 * from cwd, asserts the bin map set-equals { claudeagents-config-server, gan }
 * and version === '0.1.0'. Exits non-zero on any deviation with a precise
 * message naming what diverged.
 *
 * Run from the worktree root: `node scripts/checks/no-second-mcp-server.mjs`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkgPath = path.resolve(process.cwd(), 'package.json');
let raw;
try {
  raw = readFileSync(pkgPath, 'utf8');
} catch (e) {
  console.error(`no-second-mcp-server: cannot read ${pkgPath}: ${e.message}`);
  process.exit(1);
}
let pkg;
try {
  pkg = JSON.parse(raw);
} catch (e) {
  console.error(`no-second-mcp-server: cannot parse ${pkgPath}: ${e.message}`);
  process.exit(1);
}

const expectedBins = ['claudeagents-config-server', 'gan'].sort();
const actualBins = Object.keys(pkg.bin ?? {}).sort();
if (actualBins.length !== expectedBins.length || actualBins.some((n, i) => n !== expectedBins[i])) {
  console.error(
    `no-second-mcp-server: package.json bin set diverged. expected=[${expectedBins.join(
      ', ',
    )}] actual=[${actualBins.join(', ')}]`,
  );
  process.exit(1);
}

const expectedVersion = '0.1.0';
if (pkg.version !== expectedVersion) {
  console.error(
    `no-second-mcp-server: package.json version diverged. expected=${expectedVersion} actual=${pkg.version}`,
  );
  process.exit(1);
}

console.log('no-second-mcp-server: ok');
