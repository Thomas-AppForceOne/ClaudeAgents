

import { stableStringify } from '../../config-server/determinism/index.js';

export function emitJson(value: unknown): string {
  return stableStringify(value);
}
