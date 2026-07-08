// Electron-free so both the main process (botManager) and the safeStorage-backed vault can
// share the key scheme without pulling `electron` into an environment that has no runtime for it.

/** Vault key for a profile's server auth password. */
export function authSecretKey(profileId: string): string {
  return `${profileId}:auth`;
}

/** Vault key for a profile's proxy password. */
export function proxySecretKey(profileId: string): string {
  return `${profileId}:proxy`;
}
