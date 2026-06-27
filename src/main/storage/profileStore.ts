import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AccountProfile, AppSettings, BotModulesConfig } from '../../shared/types.js';

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
    reconnect: { ...profile.reconnect },
    proxy: profile.proxy ? { ...profile.proxy, password: '' } : profile.proxy,
    modules: profile.modules ? stripModuleSecrets(profile.modules) : profile.modules
  };
}

function stripModuleSecrets(modules: BotModulesConfig): BotModulesConfig {
  return {
    ...modules,
    area: {
      ...modules.area,
      from: { ...modules.area.from },
      to: { ...modules.area.to }
    },
    script: {
      ...modules.script,
      steps: modules.script.steps.map((step) => ({ ...step })),
      quickCommands: modules.script.quickCommands.map((step) => ({ ...step }))
    },
    discord: { ...modules.discord },
    autoResponse: {
      ...modules.autoResponse,
      rules: modules.autoResponse.rules.map((rule) => ({ ...rule }))
    }
  };
}
