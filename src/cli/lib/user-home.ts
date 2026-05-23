
export function resolveUserHome(): string | null {
  const v = process.env.GAN_USER_HOME ?? process.env.HOME ?? process.env.USERPROFILE;
  return typeof v === 'string' && v.length > 0 ? v : null;
}
