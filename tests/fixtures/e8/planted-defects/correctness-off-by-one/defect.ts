/**
 * Defective `sumAll`: loop bound is `<=` where it should be `<`, so the loop
 * reads one past the end of the array. JavaScript returns `undefined` for
 * `arr[arr.length]`, which coerces to `NaN` under arithmetic addition — so the
 * function returns `NaN` instead of the correct sum.
 *
 * Out-of-contract bug: the initial contract only says "return the sum of all
 * elements"; the planted defect causes silent NaN-poisoning rather than a
 * thrown error, so callers see a wrong result rather than an exception.
 */
export function sumAll(arr: number[]): number {
  let total = 0;
  for (let i = 0; i <= arr.length; i++) {
    total += arr[i] as number;
  }
  return total;
}
