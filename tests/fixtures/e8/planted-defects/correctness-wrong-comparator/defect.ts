/**
 * Defective `isAdmin`: compares a numeric role against a string ID using `==`
 * loose equality, so `'0' == 0` evaluates true and a user with role-id `'0'`
 * (intended to be the no-privilege placeholder) is granted admin access.
 *
 * Out-of-contract bug: the initial contract says "admin user has role-id 0";
 * the planted defect is the loose comparator that lets string-typed user
 * input from a JSON body satisfy a check that should match only the numeric
 * literal.
 */
const ADMIN_ROLE_ID = 0;

/**
 * Return `true` when `roleId` identifies the admin role.
 *
 * @param roleId role identifier, possibly arriving as a string from a JSON
 *   payload or query parameter. Untrusted.
 */
export function isAdmin(roleId: unknown): boolean {
  // BUG: loose `==` accepts '0', '00', false, [], [0], etc.
  // Should be `=== ADMIN_ROLE_ID && typeof roleId === 'number'`.
  return roleId == ADMIN_ROLE_ID;
}
