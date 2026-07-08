import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';

export { authSecretKey, proxySecretKey } from './secretKeys.js';

/** On-disk shape of `secrets.json`: opaque key → base64(ciphertext). Never holds plaintext. */
type SecretsFile = Record<string, string>;

/**
 * OS-keychain-backed store for the launcher's persistent secrets (server auth password, proxy
 * password), keyed by `${profileId}:auth` / `${profileId}:proxy`. Ciphertext lives in
 * `secrets.json` next to `profiles.json`; `profiles.json` itself stays secret-free.
 *
 * Encryption uses Electron's {@link safeStorage} (macOS Keychain / Windows DPAPI / libsecret).
 * When encryption is unavailable we NEVER fall back to plaintext — the secret simply isn't
 * persisted, matching the app's prior "in-memory only" behaviour.
 */
export class SecretVault {
  private readonly filePath: string;
  private cache: SecretsFile | null = null;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'secrets.json');
  }

  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Encrypt and persist a secret. Empty `plaintext` clears the key. Returns false without
   * writing anything when encryption is unavailable — the caller keeps the value in memory only.
   */
  async set(key: string, plaintext: string): Promise<boolean> {
    if (!plaintext) {
      await this.delete(key);
      return this.isAvailable();
    }
    if (!this.isAvailable()) return false;
    try {
      const cipher = safeStorage.encryptString(plaintext);
      const data = await this.read();
      data[key] = cipher.toString('base64');
      await this.write(data);
      return true;
    } catch (error) {
      console.warn('Secret vault encrypt failed:', error);
      return false;
    }
  }

  /** Decrypt a stored secret, or null when absent / unavailable / corrupt. */
  async get(key: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    const data = await this.read();
    const encoded = data[key];
    if (!encoded) return null;
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    } catch (error) {
      console.warn('Secret vault decrypt failed:', error);
      return null;
    }
  }

  /** Whether a ciphertext is stored for this key (does not require decryption to succeed). */
  async has(key: string): Promise<boolean> {
    const data = await this.read();
    return Boolean(data[key]);
  }

  async delete(key: string): Promise<void> {
    const data = await this.read();
    if (key in data) {
      delete data[key];
      await this.write(data);
    }
  }

  /** Drop every stored key not present in `validKeys` — e.g. after a profile is deleted. */
  async prune(validKeys: Iterable<string>): Promise<void> {
    const keep = new Set(validKeys);
    const data = await this.read();
    let changed = false;
    for (const key of Object.keys(data)) {
      if (!keep.has(key)) {
        delete data[key];
        changed = true;
      }
    }
    if (changed) await this.write(data);
  }

  private async read(): Promise<SecretsFile> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as SecretsFile;
      this.cache = parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Secret vault read failed:', error);
      }
      this.cache = {};
    }
    return this.cache;
  }

  private async write(data: SecretsFile): Promise<void> {
    this.cache = data;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }
}
