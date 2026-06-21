import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultProfiles } from '../bot/defaultProfiles';
import { ProfileStore } from './profileStore';

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe('ProfileStore', () => {
  it('does not persist lobby auth passwords to profile JSON', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'afk-launcher-store-'));
    tempDirs.push(dir);
    const store = new ProfileStore(dir);
    const profiles = createDefaultProfiles();
    const authPassword = randomUUID();

    profiles[0] = {
      ...profiles[0],
      startup: {
        ...profiles[0].startup,
        authPassword
      }
    };

    await store.save({
      profiles,
      selectedProfileId: profiles[0].id
    });

    const raw = await readFile(path.join(dir, 'profiles.json'), 'utf8');
    expect(raw).not.toContain(authPassword);
    expect(JSON.parse(raw).profiles[0].startup.authPassword).toBe('');

    const loaded = await store.load({
      profiles: [],
      selectedProfileId: null
    });
    expect(loaded.profiles[0].startup.authPassword).toBe('');
  });
});
