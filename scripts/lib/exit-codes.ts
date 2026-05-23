
export const SCRIPT_EXIT = {
  SUCCESS: 0,
  FAILURE: 1,
  BAD_ARGS: 64,
} as const;

export type ScriptExit = (typeof SCRIPT_EXIT)[keyof typeof SCRIPT_EXIT];
