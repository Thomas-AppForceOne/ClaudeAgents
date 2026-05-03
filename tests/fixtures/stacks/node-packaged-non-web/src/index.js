// Tiny entry file for the node-packaged-non-web fixture. The fixture
// has a package.json but no lockfile and no start/dev/build script, so
// the canonical web-node stack's composite detection short-circuits
// without activating it. The active set falls through to `generic`.
export function hello() {
  return 'hello';
}
