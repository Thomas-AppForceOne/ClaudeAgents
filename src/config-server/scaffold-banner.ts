/**
 * The single source of truth for the scaffold draft-banner string.
 *
 * Scaffolders (stack/overlay generators) prepend this line to freshly
 * generated files; downstream tooling matches it verbatim to detect a file
 * that the user has not yet finished editing. Because both the writer and the
 * detector import this one constant, the literal can only ever drift in one
 * place — there is no second copy to keep in sync.
 */
export const DRAFT_BANNER = '# DRAFT — replace TODOs and remove this banner before committing.';
