// @vitest-environment node

import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BotManager } from '../bot/botManager';
import { startLocalWebServer, type LocalWebServer } from './localWebServer';
import { DEFAULT_SETTINGS, type AppSettings, type LauncherState, type SaveProfileInput } from '../../shared/types';

const tempDirs: string[] = [];
const servers: LocalWebServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe('local web dashboard server', () => {
  it('serves the packaged dashboard shell', async () => {
    const staticDir = await createStaticDir();
    const server = await startTestServer({ staticDir });

    const response = await fetch(server.url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('ChunkKeeper dashboard shell');
  });

  it('exposes launcher state and mutating actions over loopback HTTP', async () => {
    const manager = new FakeManager();
    const server = await startTestServer({ manager });

    const stateResponse = await fetch(`${server.url}/api/state`);
    const state = (await stateResponse.json()) as LauncherState;

    expect(stateResponse.status).toBe(200);
    expect(state.runtime.appVersion).toBe('test');
    expect(state.runtime.onlineCount).toBe(0);

    const actionResponse = await fetch(`${server.url}/api/bots/start-all`, { method: 'POST' });
    const updatedState = (await actionResponse.json()) as LauncherState;

    expect(actionResponse.status).toBe(200);
    expect(updatedState.runtime.onlineCount).toBe(1);
    expect(manager.startAllCalls).toBe(1);
  });

  it('rejects browser requests from non-local origins', async () => {
    const server = await startTestServer();

    const response = await fetch(`${server.url}/api/state`, {
      headers: {
        Origin: 'https://example.com'
      }
    });

    expect(response.status).toBe(403);
  });
});

async function startTestServer({
  manager = new FakeManager(),
  staticDir
}: {
  manager?: FakeManager;
  staticDir?: string;
} = {}): Promise<LocalWebServer> {
  const server = await startLocalWebServer({
    manager: manager as unknown as BotManager,
    staticDir: staticDir ?? (await createStaticDir()),
    preferredPort: 0,
    openUserData: async () => undefined
  });
  servers.push(server);
  return server;
}

async function createStaticDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chunkkeeper-web-'));
  tempDirs.push(dir);
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>ChunkKeeper dashboard shell</title>', 'utf8');
  return dir;
}

class FakeManager extends EventEmitter {
  startAllCalls = 0;
  private state = createState();

  getState(): LauncherState {
    return structuredClone(this.state);
  }

  async saveProfile(profile: SaveProfileInput): Promise<LauncherState> {
    const id = profile.id ?? 'new-profile';
    this.state.profiles = [...this.state.profiles, { ...profile, id }];
    this.state.selectedProfileId = id;
    return this.publish();
  }

  async deleteProfile(profileId: string): Promise<LauncherState> {
    this.state.profiles = this.state.profiles.filter((profile) => profile.id !== profileId);
    return this.publish();
  }

  async selectProfile(profileId: string): Promise<LauncherState> {
    this.state.selectedProfileId = profileId;
    return this.publish();
  }

  async connect(): Promise<LauncherState> {
    this.state.runtime.onlineCount = 1;
    return this.publish();
  }

  async disconnect(): Promise<LauncherState> {
    this.state.runtime.onlineCount = 0;
    return this.publish();
  }

  async startAll(): Promise<LauncherState> {
    this.startAllCalls += 1;
    this.state.runtime.onlineCount = 1;
    return this.publish();
  }

  async stopAll(): Promise<LauncherState> {
    this.state.runtime.onlineCount = 0;
    return this.publish();
  }

  async sendChat(): Promise<LauncherState> {
    return this.publish();
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<LauncherState> {
    this.state.settings = { ...this.state.settings, ...patch };
    return this.publish();
  }

  private publish(): LauncherState {
    const state = this.getState();
    this.emit('state', state);
    return state;
  }
}

function createState(): LauncherState {
  return {
    profiles: [
      {
        id: 'session-01',
        label: 'SESSION_01',
        username: '',
        host: '127.0.0.1',
        port: 25565,
        version: false,
        authMode: 'offline',
        enabled: true,
        startup: {
          enabled: false,
          authMode: 'none',
          authCommandTemplate: '/login {password}',
          registerCommandTemplate: '/register {password} {password}',
          authPassword: '',
          authDelayMs: 2500,
          transferCommand: '/smp',
          transferDelayMs: 3500,
          flowCommands: []
        },
        routine: {
          randomLook: true,
          autoJump: true,
          sneakPulse: false,
          swingArm: true,
          chatHeartbeat: false,
          autoRespawn: true,
          autoEat: true,
          eatAtFood: 14,
          pauseAtFood: 6,
          intervalMs: 18000,
          jitterPercent: 0,
          chatMessages: []
        },
        reconnect: {
          enabled: true,
          maxAttempts: 8,
          baseDelayMs: 5000,
          maxDelayMs: 90000
        }
      }
    ],
    sessions: {},
    runtime: {
      appVersion: 'test',
      systemState: 'online',
      botCount: 1,
      onlineCount: 0,
      webDashboardUrl: null,
      authSessionDir: '/tmp/chunkkeeper-auth',
      estimatedRamMb: 180,
      latestError: null
    },
    settings: structuredClone(DEFAULT_SETTINGS),
    selectedProfileId: 'session-01'
  };
}
