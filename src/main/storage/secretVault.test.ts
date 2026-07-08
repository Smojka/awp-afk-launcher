import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reversible fake for Electron's safeStorage. `available` is toggled per-test to exercise the
// no-plaintext-fallback path. Ciphertext is `enc:<plaintext>` so tests can assert it is NOT the
// raw secret while remaining decryptable.
const state = { available: true };
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (text: string) => Buffer.from(`enc:${text}`, 'utf8'),
    decryptString: (buffer: Buffer) => buffer.toString('utf8').replace(/^enc:/, '')
  }
}));

import { SecretVault, authSecretKey, proxySecretKey } from './secretVault';

let dir: string;

beforeEach(async () => {
  state.available = true;
  dir = await mkdtemp(path.join(tmpdir(), 'secret-vault-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SecretVault', () => {
  it('round-trips a secret and stores ciphertext, not plaintext', async () => {
    const vault = new SecretVault(dir);
    const stored = await vault.set(authSecretKey('p1'), 'hunter2');
    expect(stored).toBe(true);
    expect(await vault.get(authSecretKey('p1'))).toBe('hunter2');

    const onDisk = await readFile(path.join(dir, 'secrets.json'), 'utf8');
    expect(onDisk).not.toContain('hunter2');
    expect(onDisk).toContain(Buffer.from('enc:hunter2', 'utf8').toString('base64'));
  });

  it('persists across instances (survives restart)', async () => {
    await new SecretVault(dir).set(proxySecretKey('p1'), 'proxypass');
    const reopened = new SecretVault(dir);
    expect(await reopened.get(proxySecretKey('p1'))).toBe('proxypass');
  });

  it('never writes plaintext when encryption is unavailable', async () => {
    state.available = false;
    const vault = new SecretVault(dir);
    const stored = await vault.set(authSecretKey('p1'), 'hunter2');
    expect(stored).toBe(false);
    expect(await vault.get(authSecretKey('p1'))).toBeNull();
    await expect(readFile(path.join(dir, 'secrets.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats an empty value as a clear', async () => {
    const vault = new SecretVault(dir);
    await vault.set(authSecretKey('p1'), 'secret');
    expect(await vault.has(authSecretKey('p1'))).toBe(true);
    await vault.set(authSecretKey('p1'), '');
    expect(await vault.has(authSecretKey('p1'))).toBe(false);
    expect(await vault.get(authSecretKey('p1'))).toBeNull();
  });

  it('deletes and prunes orphaned keys', async () => {
    const vault = new SecretVault(dir);
    await vault.set(authSecretKey('p1'), 'a');
    await vault.set(authSecretKey('p2'), 'b');
    await vault.set(proxySecretKey('p2'), 'c');

    await vault.delete(authSecretKey('p1'));
    expect(await vault.has(authSecretKey('p1'))).toBe(false);

    // Only p2 survives a profile-set prune.
    await vault.prune([authSecretKey('p2'), proxySecretKey('p2')]);
    expect(await vault.get(authSecretKey('p2'))).toBe('b');
    expect(await vault.get(proxySecretKey('p2'))).toBe('c');
    expect(await vault.has(authSecretKey('p1'))).toBe(false);
  });
});
