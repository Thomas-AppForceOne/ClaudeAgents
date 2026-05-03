/**
 * Module loader (R1 no-op).
 *
 * Per R1's "module surface no-op contract" (PROJECT_CONTEXT.md, OQ4):
 * `listInstalledModules` returns `[]` and `loadModuleState` returns `null`
 * until M1 ships `module-manifest-v1.json` and the runtime module
 * discovery logic. The surface exists so E1 / R3 / R4 can be authored
 * against it; behaviour arrives with M1.
 *
 * The `projectRoot` and `name` parameters are accepted (and validated as
 * non-empty strings) so future implementations can land without changing
 * the call sites in `tools/reads.ts`.
 */

export interface ModuleStateRecord {
  name: string;
  state: unknown;
}

export function listInstalledModules(_projectRoot: string): string[] {
  return [];
}

export function loadModuleState(_name: string, _projectRoot: string): ModuleStateRecord | null {
  return null;
}
