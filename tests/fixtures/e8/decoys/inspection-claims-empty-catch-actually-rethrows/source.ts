/**
 * Decoy source for the `inspection-claims-empty-catch-actually-rethrows`
 * decoy.
 *
 * The faked finding's evidencePointer cites line 11 and claims an empty
 * `catch {}` block. The cited code in fact logs the error and rethrows it —
 * the textbook non-swallow pattern. The contract-reviewer's well-foundedness
 * audit reads the cited code, sees the rethrow, and rejects the
 * finding-derived criterion as ill-formed.
 */
export function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    // Line 11 (per the decoy's evidencePointer): logs + rethrows, NOT empty.
    console.error('tryParse: failed to parse JSON', err);
    throw err;
  }
}
