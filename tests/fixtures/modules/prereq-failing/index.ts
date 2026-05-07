/**
 * Fixture barrel for the `prereq-failing` module.
 *
 * The barrel never actually loads at runtime in tests: the prerequisite
 * check fails first and the loader throws. The file exists so the
 * fixture's directory shape mirrors the real module layout.
 */

export const sentinel = 'prereq-failing/index.ts loaded' as const;
