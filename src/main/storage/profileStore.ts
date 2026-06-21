import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccountProfile, AppSettings } from '../../shared/types.js';

export interface ProfileDocument {
  selectedProfileId: string | null;
  profiles: AccountProfile[];
  settings?: AppSettings;
}

export class ProfileStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    this.filePath = path.join(baseDir, 'profiles.json');
  }

  async load(defaultDocument: ProfileDocument): Promise<ProfileDocument> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as ProfileDocument;
      if (!Array.isArray(parsed.profiles)) {
        return defaultDocument;
      }
      return {
        selectedProfileId: parsed.selectedProfileId ?? parsed.profiles[0]?.id ?? null,
        profiles: parsed.profiles.map(stripProfileSecrets),
        settings: parsed.settings
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Profile store load failed:', error);
      }
      return defaultDocument;
    }
  }

  async save(document: ProfileDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      `${JSON.stringify({ ...document, profiles: document.profiles.map(stripProfileSecrets) }, null, 2)}\n`,
      'utf8'
    );
  }
}

function stripProfileSecrets(profile: AccountProfile): AccountProfile {
  return {
    ...profile,
    startup: {
      ...profile.startup,
      authPassword: ''
    },
    routine: {
      ...profile.routine,
      chatMessages: [...profile.routine.chatMessages]
    },
    reconnect: { ...profile.reconnect }
  };
}
