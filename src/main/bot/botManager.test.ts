import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotManager, type MineflayerFactory } from './botManager';
import type { AccountProfile } from '../../shared/types';
import type { ProfileDocument } from '../storage/profileStore';

class MemoryStore {
  document: ProfileDocument;

  constructor(profiles: AccountProfile[]) {
    this.document = { profiles, selectedProfileId: profiles[0]?.id ?? null };
  }

  async load() {
    return this.document;
  }

  async save(document: ProfileDocument) {
    this.document = document;
  }
}

class FakeBot extends EventEmitter {
  _client = new EventEmitter();
  registry = {
    foods: {
      815: { id: 815, name: 'bread', displayName: 'Bread', foodPoints: 5, saturation: 6, effectiveQuality: 11 },
      822: { id: 822, name: 'cooked_beef', displayName: 'Steak', foodPoints: 8, saturation: 12.8, effectiveQuality: 20.8 },
      835: { id: 835, name: 'rotten_flesh', displayName: 'Rotten Flesh', foodPoints: 4, saturation: 0.8, effectiveQuality: 4.8 }
    },
    foodsByName: {
      bread: { id: 815, name: 'bread', displayName: 'Bread', foodPoints: 5, saturation: 6, effectiveQuality: 11 },
      cooked_beef: { id: 822, name: 'cooked_beef', displayName: 'Steak', foodPoints: 8, saturation: 12.8, effectiveQuality: 20.8 },
      rotten_flesh: { id: 835, name: 'rotten_flesh', displayName: 'Rotten Flesh', foodPoints: 4, saturation: 0.8, effectiveQuality: 4.8 }
    }
  };
  health = 20;
  food = 18;
  player = { ping: 42 };
  game = { dimension: 'overworld' };
  players = { one: {}, two: {} };
  entity = { position: { x: 12.4, y: 65, z: -9.8 }, yaw: 0.2, pitch: -0.1 };
  inventory = { slots: new Array(46), items: () => [] as Array<{ type?: number; name: string; displayName?: string }> };
  chat = vi.fn();
  quit = vi.fn(() => this.emit('end'));
  setControlState = vi.fn();
  look = vi.fn();
  swingArm = vi.fn();
  respawn = vi.fn();
  equip = vi.fn(async () => undefined);
  consume = vi.fn(async () => {
    this.food = 20;
  });
  acceptResourcePack = vi.fn();
}

const testUsername = randomUUID();

const profile: AccountProfile = {
  id: 'session-test',
  label: 'SESSION_TEST',
  username: testUsername,
  host: 'localhost',
  port: 25565,
  version: false,
  authMode: 'offline',
  enabled: true,
  startup: {
    enabled: false,
    authMode: 'login',
    authCommandTemplate: '/login {password}',
    registerCommandTemplate: '/register {password} {password}',
    authPassword: '',
    authDelayMs: 2500,
    transferCommand: '/smp',
    transferDelayMs: 3500
  },
  routine: {
    randomLook: true,
    autoJump: true,
    sneakPulse: false,
    swingArm: false,
    chatHeartbeat: false,
    autoRespawn: true,
    autoEat: true,
    eatAtFood: 14,
    pauseAtFood: 6,
    intervalMs: 60000,
    jitterPercent: 0,
    chatMessages: []
  },
  reconnect: {
    enabled: false,
    maxAttempts: 0,
    baseDelayMs: 5000,
    maxDelayMs: 90000
  }
};

afterEach(() => {
  vi.useRealTimers();
});

describe('BotManager', () => {
  it('connects through the injected Mineflayer factory and records live telemetry', async () => {
    const fakeBot = new FakeBot();
    const factory: MineflayerFactory = vi.fn(() => fakeBot);
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    fakeBot.emit('health');

    const state = manager.getState();
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ host: 'localhost', auth: 'offline' }));
    expect(state.sessions[profile.id].state).toBe('online');
    expect(state.sessions[profile.id].health).toBe(20);
    expect(state.sessions[profile.id].food).toBe(18);
    expect(state.sessions[profile.id].position).toEqual(expect.objectContaining({ x: 12.4, y: 65, z: -9.8 }));
    expect(state.sessions[profile.id].routineActive).toBe(true);
  });

  it('auto-eats inventory food before low hunger can become starvation damage', async () => {
    const fakeBot = new FakeBot();
    fakeBot.food = 10;
    fakeBot.inventory.items = () => [{ type: 815, name: 'bread', displayName: 'Bread' }];
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    await Promise.resolve();
    await Promise.resolve();

    const state = manager.getState();
    expect(fakeBot.setControlState).toHaveBeenCalledWith('jump', false);
    expect(fakeBot.setControlState).toHaveBeenCalledWith('sneak', false);
    expect(fakeBot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'bread' }), 'hand');
    expect(fakeBot.consume).toHaveBeenCalledTimes(1);
    expect(state.sessions[profile.id].food).toBe(20);
    expect(state.sessions[profile.id].events.some((event) => event.type === 'eat' && event.label === 'Food consumed')).toBe(true);
  });

  it('chooses the best safe registry-backed food and skips harmful food', async () => {
    const fakeBot = new FakeBot();
    fakeBot.food = 10;
    fakeBot.inventory.items = () => [
      { type: 835, name: 'rotten_flesh', displayName: 'Rotten Flesh' },
      { type: 815, name: 'bread', displayName: 'Bread' },
      { type: 822, name: 'cooked_beef', displayName: 'Steak' }
    ];
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    await Promise.resolve();
    await Promise.resolve();

    expect(fakeBot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'cooked_beef' }), 'hand');
    expect(fakeBot.equip).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'rotten_flesh' }), 'hand');
    expect(fakeBot.consume).toHaveBeenCalledTimes(1);
  });

  it('pauses the AFK routine at critical hunger when no food is available, then resumes after recovery', async () => {
    const fakeBot = new FakeBot();
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');

    fakeBot.food = 4;
    fakeBot.emit('health');
    let state = manager.getState();
    expect(state.sessions[profile.id].routineActive).toBe(false);
    expect(state.sessions[profile.id].state).toBe('warning');
    expect(state.sessions[profile.id].events.some((event) => event.type === 'eat' && event.label === 'Food required')).toBe(true);

    fakeBot.food = 18;
    fakeBot.emit('health');
    state = manager.getState();
    expect(state.sessions[profile.id].routineActive).toBe(true);
    expect(state.sessions[profile.id].state).toBe('online');
    expect(state.sessions[profile.id].events.some((event) => event.type === 'eat' && event.label === 'Hunger recovered')).toBe(true);
  });

  it('requests respawn after death when auto-respawn is enabled', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    fakeBot.emit('death');

    expect(fakeBot.respawn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);

    const state = manager.getState();
    expect(fakeBot.respawn).toHaveBeenCalledTimes(1);
    expect(state.sessions[profile.id].events.some((event) => event.type === 'respawn' && event.label === 'Respawn requested')).toBe(true);
  });

  it('applies saved routine toggle changes to an already running session', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    const jumpOnlyProfile: AccountProfile = {
      ...profile,
      routine: {
        ...profile.routine,
        randomLook: false,
        autoJump: true,
        sneakPulse: false,
        swingArm: false,
        chatHeartbeat: false,
        intervalMs: 3000,
        jitterPercent: 0
      }
    };
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([jumpOnlyProfile])
    });

    await manager.load();
    await manager.connect(jumpOnlyProfile.id);
    fakeBot.emit('spawn');
    await vi.advanceTimersByTimeAsync(3000);
    expect(fakeBot.setControlState).toHaveBeenCalledWith('jump', true);

    fakeBot.setControlState.mockClear();
    const state = await manager.saveProfile({
      ...jumpOnlyProfile,
      routine: {
        ...jumpOnlyProfile.routine,
        autoJump: false
      }
    });

    expect(state.profiles[0].routine.autoJump).toBe(false);
    expect(state.sessions[jumpOnlyProfile.id].events.some((event) => event.label === 'Routine updated')).toBe(true);
    expect(fakeBot.setControlState).toHaveBeenCalledWith('jump', false);

    fakeBot.setControlState.mockClear();
    await vi.advanceTimersByTimeAsync(9000);
    expect(fakeBot.setControlState).not.toHaveBeenCalledWith('jump', true);
  });

  it('uses the reconnect policy after an unexpected disconnect', async () => {
    vi.useFakeTimers();
    const bots: FakeBot[] = [];
    const factory: MineflayerFactory = vi.fn(() => {
      const bot = new FakeBot();
      bots.push(bot);
      return bot;
    });
    const reconnectProfile: AccountProfile = {
      ...profile,
      reconnect: {
        enabled: true,
        maxAttempts: 2,
        baseDelayMs: 1000,
        maxDelayMs: 1000
      }
    };
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory,
      store: new MemoryStore([reconnectProfile])
    });

    await manager.load();
    await manager.connect(profile.id);
    bots[0].emit('end');

    let state = manager.getState();
    expect(state.sessions[profile.id].state).toBe('reconnecting');
    expect(state.sessions[profile.id].reconnectAttempts).toBe(1);
    expect(state.sessions[profile.id].nextReconnectAt).toEqual(expect.any(String));

    await vi.advanceTimersByTimeAsync(1000);

    state = manager.getState();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(state.sessions[profile.id].state).toBe('connecting');
  });

  it('starts only enabled accounts in bulk', async () => {
    const factory: MineflayerFactory = vi.fn(() => new FakeBot());
    const disabledProfile: AccountProfile = {
      ...profile,
      id: 'session-disabled',
      label: 'SESSION_DISABLED',
      username: randomUUID(),
      enabled: false
    };
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory,
      store: new MemoryStore([profile, disabledProfile])
    });

    await manager.load();
    await manager.startAll();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(expect.objectContaining({ username: profile.username }));
  });

  it('blocks connections until a username is configured', async () => {
    const fakeBot = new FakeBot();
    const factory: MineflayerFactory = vi.fn(() => fakeBot);
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory,
      store: new MemoryStore([{ ...profile, username: '' }])
    });

    await manager.load();
    const state = await manager.connect(profile.id);

    expect(factory).not.toHaveBeenCalled();
    expect(state.sessions[profile.id].state).toBe('error');
    expect(state.sessions[profile.id].lastError).toBe('Username is required before connecting.');
  });

  it('routes chat only when the selected bot is online', async () => {
    const fakeBot = new FakeBot();
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.sendChat(profile.id, 'offline message');
    expect(fakeBot.chat).not.toHaveBeenCalled();

    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    await manager.sendChat(profile.id, 'hello server');
    expect(fakeBot.chat).toHaveBeenCalledWith('hello server');
  });

  it('accepts mandatory server resource packs before world spawn can continue', async () => {
    const fakeBot = new FakeBot();
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot._client.emit('add_resource_pack', { uuid: 'd69238f2-b7ce-30b0-8262-17cd9490f29d' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeBot.acceptResourcePack).toHaveBeenCalledTimes(1);
  });

  it('runs lobby register before transfer when register mode is selected', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    const testAuthPassword = randomUUID();
    const startupProfile: AccountProfile = {
      ...profile,
      startup: {
        enabled: true,
        authMode: 'register',
        authCommandTemplate: '/login {password}',
        registerCommandTemplate: '/register {password} {password}',
        authPassword: testAuthPassword,
        authDelayMs: 1000,
        transferCommand: '/smp',
        transferDelayMs: 1500
      }
    };
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([startupProfile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');

    vi.advanceTimersByTime(1000);
    expect(fakeBot.chat).toHaveBeenCalledWith(`/register ${testAuthPassword} ${testAuthPassword}`);

    vi.advanceTimersByTime(1500);
    expect(fakeBot.chat).toHaveBeenCalledWith('/smp');
    vi.advanceTimersByTime(500);

    const state = manager.getState();
    expect(state.sessions[profile.id].events.some((event) => event.label === 'Lobby register sent')).toBe(true);
    expect(state.sessions[profile.id].events.some((event) => event.detail?.includes(testAuthPassword))).toBe(false);
  });

  it('runs lobby auth and SMP transfer before starting the AFK routine', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    const testAuthPassword = randomUUID();
    const startupProfile: AccountProfile = {
      ...profile,
      startup: {
        enabled: true,
        authMode: 'login',
        authCommandTemplate: '/login {password}',
        registerCommandTemplate: '/register {password} {password}',
        authPassword: testAuthPassword,
        authDelayMs: 1000,
        transferCommand: '/smp',
        transferDelayMs: 1500
      }
    };
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([startupProfile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');

    expect(manager.getState().sessions[profile.id].startupActive).toBe(true);
    expect(manager.getState().sessions[profile.id].routineActive).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(fakeBot.chat).toHaveBeenCalledWith(`/login ${testAuthPassword}`);

    vi.advanceTimersByTime(1500);
    expect(fakeBot.chat).toHaveBeenCalledWith('/smp');
    expect(fakeBot.chat).toHaveBeenCalledTimes(2);

    fakeBot.emit('spawn');
    vi.advanceTimersByTime(2500);
    expect(fakeBot.chat).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(500);
    const state = manager.getState();
    expect(state.sessions[profile.id].startupActive).toBe(false);
    expect(state.sessions[profile.id].routineActive).toBe(true);
    expect(state.sessions[profile.id].events.some((event) => event.detail?.includes(testAuthPassword))).toBe(false);

    fakeBot.emit('spawn');
    vi.advanceTimersByTime(3000);
    expect(fakeBot.chat).toHaveBeenCalledTimes(2);
  });

  it('keeps lobby auth password in runtime memory but strips it from persisted profiles', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    const testAuthPassword = randomUUID();
    const store = new MemoryStore([profile]);
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store
    });

    await manager.load();
    await manager.saveProfile({
      ...profile,
      startup: {
        ...profile.startup,
        enabled: true,
        authPassword: testAuthPassword,
        authDelayMs: 1000,
        transferDelayMs: 1000
      }
    });

    expect(store.document.profiles[0].startup.authPassword).toBe('');

    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    vi.advanceTimersByTime(1000);

    expect(fakeBot.chat).toHaveBeenCalledWith(`/login ${testAuthPassword}`);
    expect(manager.getState().sessions[profile.id].events.some((event) => event.detail?.includes(testAuthPassword))).toBe(false);
  });
});
