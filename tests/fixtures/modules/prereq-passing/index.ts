/**
 * Fixture barrel for the `prereq-passing` module.
 *
 * Exists so the lifecycle test can confirm a module with passing
 * prerequisites loads cleanly. The barrel re-exports a single sentinel
 * marker; consumers assert on the marker's presence rather than running
 * any real logic.
 */

export const sentinel = 'prereq-passing/index.ts loaded' as const;
