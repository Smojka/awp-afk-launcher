import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotManager, cactusFarmPlan, cropBuildPlan, type MineflayerFactory } from './botManager';
import type { CactusFarmConfig, CropFarmConfig } from '../../shared/types';
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
  username?: string;
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
  blockAt = vi.fn((position: { x: number; y: number; z: number }) => ({
    name: 'stone',
    displayName: 'Stone',
    position,
    boundingBox: 'block',
    metadata: 0
  }));
  dig = vi.fn(async () => undefined);
  placeBlock = vi.fn(async () => undefined);
  activateBlock = vi.fn(async () => undefined);
  activateItem = vi.fn(async () => undefined);
  lookAt = vi.fn(async () => undefined);
  tabComplete = vi.fn(async (partial: string) => [`${partial}pawn`, '/home']);
  acceptResourcePack = vi.fn();
}

/**
 * Give a FakeBot a tiny mutable voxel world so build operations can place blocks
 * that later steps anchor against (a static blockAt mock can't reflect placements,
 * and placeBlockAgainst's idempotent guard would short-circuit on it).
 * Ground is solid up to groundY; everything above is air until something is placed.
 */
function attachWorld(bot: FakeBot, groundName = 'stone', groundY = 64) {
  const placed = new Map<string, string>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const floor = (p: { x: number; y: number; z: number }) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  let held: string | null = null;
  let lastLook: { x: number; y: number; z: number } | null = null;
  // Reassign mocks through a loose alias: the closures take args the default
  // (arg-less) mocks don't, which the narrow class field types would reject.
  const b = bot as unknown as Record<string, ReturnType<typeof vi.fn>>;

  b.equip = vi.fn(async (item: { name?: string }) => {
    held = item?.name ?? null;
  });
  b.blockAt = vi.fn((p: { x: number; y: number; z: number }) => {
    const c = floor(p);
    const name = placed.get(key(c.x, c.y, c.z)) ?? (c.y <= groundY ? groundName : 'air');
    return { name, displayName: name, position: p, boundingBox: name === 'air' ? 'empty' : 'block', metadata: 7 };
  });
  b.placeBlock = vi.fn(async (ref: { position: { x: number; y: number; z: number } }, face: { x: number; y: number; z: number }) => {
    const c = floor({ x: ref.position.x + face.x, y: ref.position.y + face.y, z: ref.position.z + face.z });
    placed.set(key(c.x, c.y, c.z), held ?? 'stone');
  });
  b.dig = vi.fn(async (block: { position: { x: number; y: number; z: number } }) => {
    const c = floor(block.position);
    placed.set(key(c.x, c.y, c.z), 'air');
  });
  b.activateBlock = vi.fn(async (block: { position: { x: number; y: number; z: number } }) => {
    const c = floor(block.position);
    placed.set(key(c.x, c.y, c.z), 'farmland');
  });
  b.lookAt = vi.fn(async (p: { x: number; y: number; z: number }) => {
    lastLook = floor(p);
  });
  b.activateItem = vi.fn(async () => {
    if (lastLook) placed.set(key(lastLook.x, lastLook.y, lastLook.z), 'water');
  });
  return { placed, key };
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
    transferDelayMs: 3500,
    flowCommands: []
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

  it('normalizes Minecraft JSON kick reasons before showing status text', async () => {
    const fakeBot = new FakeBot();
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('kicked', '{"text":"Çok hızlı bağlanmaya çalışıyorsun, daha sonra tekrar dene."}');

    let state = manager.getState();
    expect(state.sessions[profile.id].lastError).toBe('Çok hızlı bağlanmaya çalışıyorsun, daha sonra tekrar dene.');
    expect(state.sessions[profile.id].lastError).not.toContain('{"text"');
    expect(state.sessions[profile.id].events[0].detail).toBe('Çok hızlı bağlanmaya çalışıyorsun, daha sonra tekrar dene.');

    fakeBot.emit('kicked', { text: '', extra: [{ text: 'Rate limit' }, { text: ': wait before reconnecting' }] });

    state = manager.getState();
    expect(state.sessions[profile.id].lastError).toBe('Rate limit: wait before reconnecting');
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
        transferDelayMs: 1500,
        flowCommands: []
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
        transferDelayMs: 1500,
        flowCommands: []
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

  it('runs optional flow commands after SMP transfer before starting the AFK routine', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    const startupProfile: AccountProfile = {
      ...profile,
      startup: {
        ...profile.startup,
        enabled: true,
        authMode: 'none',
        authDelayMs: 500,
        transferCommand: '/smp',
        transferDelayMs: 1000,
        flowCommands: [
          { id: 'flow-home', label: 'Home base', command: '/home base', delayMs: 1500 },
          { id: 'flow-afk', label: 'AFK warp', command: '/warp afk', delayMs: 750 }
        ]
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

    vi.advanceTimersByTime(1500);
    expect(fakeBot.chat).toHaveBeenCalledWith('/smp');
    expect(fakeBot.chat).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1500);
    expect(fakeBot.chat).toHaveBeenCalledWith('/home base');
    expect(fakeBot.chat).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(750);
    expect(fakeBot.chat).toHaveBeenCalledWith('/warp afk');
    expect(fakeBot.chat).toHaveBeenCalledTimes(3);
    expect(manager.getState().sessions[profile.id].routineActive).toBe(false);

    vi.advanceTimersByTime(500);
    const state = manager.getState();
    expect(state.sessions[profile.id].startupActive).toBe(false);
    expect(state.sessions[profile.id].routineActive).toBe(true);
    expect(state.sessions[profile.id].events.some((event) => event.label === 'Home base' && event.detail === '/home base')).toBe(true);
    expect(state.sessions[profile.id].events.some((event) => event.label === 'AFK warp' && event.detail === '/warp afk')).toBe(true);
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

  it('blocks cactus farm construction until required materials are present', async () => {
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
    const state = await manager.startOperation(profile.id, {
      kind: 'cactusFarm',
      config: { layers: 1, radius: 1, placementDelayMs: 100 }
    });

    expect(state.sessions[profile.id].operations.cactusFarm.state).toBe('blocked');
    expect(state.sessions[profile.id].operations.cactusFarm.detail).toContain('Missing materials');
    expect(fakeBot.placeBlock).not.toHaveBeenCalled();
  });

  it('builds the automatic cactus farm and equips every required material', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    fakeBot.inventory.items = () => [
      { name: 'sand', displayName: 'Sand', count: 64 },
      { name: 'cactus', displayName: 'Cactus', count: 64 },
      { name: 'oak_fence', displayName: 'Oak Fence', count: 64 },
      { name: 'hopper', displayName: 'Hopper', count: 64 }
    ];
    attachWorld(fakeBot);
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    await manager.startOperation(profile.id, {
      kind: 'cactusFarm',
      config: { radius: 1, placementDelayMs: 50, build: true, breakBlock: 'oak_fence', buildCollection: true }
    });
    await vi.advanceTimersByTimeAsync(5000);

    const state = manager.getState();
    const operation = state.sessions[profile.id].operations.cactusFarm;
    expect(fakeBot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'sand' }), 'hand');
    expect(fakeBot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'cactus' }), 'hand');
    expect(fakeBot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'oak_fence' }), 'hand');
    expect(fakeBot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'hopper' }), 'hand');
    expect(operation.state).toBe('complete');
    // radius 1 → 2 cactus units × 7 placements (sand, cactus, 3× post, trigger, hopper)
    expect(operation.total).toBe(14);
    expect(operation.completed).toBe(14);
    expect(fakeBot.placeBlock).toHaveBeenCalledTimes(14);
    // the trigger leans on the post top via a SIDE face (-Z) — impossible with the
    // old below-only placeItemAt, which is why placeBlockAgainst exists.
    const placeCalls = fakeBot.placeBlock.mock.calls as unknown as Array<[unknown, { x: number; y: number; z: number }]>;
    const usedSideFace = placeCalls.some(([, face]) => face && face.z === -1);
    expect(usedSideFace).toBe(true);
  });

  it('builds a crop farm (till + water + plant) then hands off to the harvest loop', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    fakeBot.inventory.items = () => [
      { name: 'wheat_seeds', displayName: 'Wheat Seeds', count: 64 },
      { name: 'iron_hoe', displayName: 'Iron Hoe', count: 1 },
      { name: 'water_bucket', displayName: 'Water Bucket', count: 1 }
    ];
    attachWorld(fakeBot, 'dirt');
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    await manager.startOperation(profile.id, {
      kind: 'cropFarm',
      config: { crop: 'wheat', radius: 1, harvestDelayMs: 20, build: true, autoTill: true, waterMode: 'auto' }
    });
    await vi.advanceTimersByTimeAsync(3000);

    // radius 1 → 3×3 square, centre is water → 8 farmland cells
    expect(fakeBot.activateBlock).toHaveBeenCalledTimes(8); // till each cell
    expect(fakeBot.equip).toHaveBeenCalledWith(expect.objectContaining({ name: 'wheat_seeds' }), 'hand');
    expect(fakeBot.activateItem).toHaveBeenCalledTimes(1); // one water source
    // at least 8 seed placements happened during the build
    expect(fakeBot.placeBlock.mock.calls.length).toBeGreaterThanOrEqual(8);

    const operation = manager.getState().sessions[profile.id].operations.cropFarm;
    expect(operation.state).toBe('running');
    expect(operation.total).toBeNull();
    expect((operation.detail ?? '').toLowerCase()).toContain('hasat');
  });

  it('blocks the crop build when auto water cannot be placed and no water exists', async () => {
    vi.useFakeTimers();
    const fakeBot = new FakeBot();
    fakeBot.inventory.items = () => [
      { name: 'wheat_seeds', displayName: 'Wheat Seeds', count: 64 },
      { name: 'iron_hoe', displayName: 'Iron Hoe', count: 1 },
      { name: 'water_bucket', displayName: 'Water Bucket', count: 1 }
    ];
    attachWorld(fakeBot, 'dirt');
    // bucket use is a no-op here, so the centre never becomes water
    fakeBot.activateItem = vi.fn(async () => undefined);
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([profile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    await manager.startOperation(profile.id, {
      kind: 'cropFarm',
      config: { crop: 'wheat', radius: 1, harvestDelayMs: 20, build: true, autoTill: true, waterMode: 'auto' }
    });
    await vi.advanceTimersByTimeAsync(3000);

    const operation = manager.getState().sessions[profile.id].operations.cropFarm;
    expect(operation.state).toBe('blocked');
    expect((operation.detail ?? '').toLowerCase()).toContain('water');
  });

  it('runs quick scripts and exposes tab-completion suggestions from the bot', async () => {
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
    await manager.runQuickScript(profile.id, '/spawn');
    const completions = await manager.completeChat(profile.id, '/s');

    expect(fakeBot.chat).toHaveBeenCalledWith('/spawn');
    expect(completions).toEqual(['/spawn', '/home']);
    expect(manager.getState().sessions[profile.id].tabCompletions).toEqual(['/spawn', '/home']);
  });

  it('auto-responds to matching server chat with per-rule cooldowns', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-25T10:00:00Z'));
    const fakeBot = new FakeBot();
    fakeBot.username = testUsername;
    const autoResponseProfile: AccountProfile = {
      ...profile,
      modules: {
        cactusFarm: { enabled: false, layers: 1, radius: 1, placementDelayMs: 100, build: true, breakBlock: 'oak_fence', buildCollection: true },
        cropFarm: { enabled: false, crop: 'wheat', radius: 2, harvestDelayMs: 100, replant: true, collectDrops: true, build: true, autoTill: true, waterMode: 'auto' },
        area: {
          enabled: false,
          mode: 'mine',
          from: { x: 0, y: 0, z: 0 },
          to: { x: 1, y: 1, z: 1 },
          fillBlock: 'stone',
          actionDelayMs: 100
        },
        generator: { enabled: false, mode: 'forward', direction: 'north', depth: 2, actionDelayMs: 100 },
        script: { enabled: false, loop: true, steps: [], quickCommands: [] },
        discord: {
          enabled: false,
          commandPrefix: '!ck ',
          notifyChat: true,
          notifyEvents: true,
          pollCommands: false,
          pollIntervalMs: 10000,
          channelId: ''
        },
        autoResponse: {
          enabled: true,
          rules: [
            {
              id: 'accept-tpa',
              enabled: true,
              label: 'TPA accept',
              match: 'tpa',
              response: '/tpaccept',
              cooldownMs: 5000
            }
          ]
        }
      }
    };
    const manager = new BotManager({
      userDataDir: '/tmp/afk-launcher-test',
      appVersion: '0.1.0',
      factory: () => fakeBot,
      store: new MemoryStore([autoResponseProfile])
    });

    await manager.load();
    await manager.connect(profile.id);
    fakeBot.emit('spawn');
    fakeBot.emit('chat', 'Friend', 'please tpa accept');

    expect(fakeBot.chat).toHaveBeenCalledWith('/tpaccept');
    let state = manager.getState();
    expect(state.sessions[profile.id].chat.some((line) => line.source === 'bot' && line.message === '/tpaccept')).toBe(true);
    expect(state.sessions[profile.id].events.some((event) => event.type === 'autoReply' && event.label === 'Auto response sent')).toBe(true);

    fakeBot.emit('chat', 'Friend', 'tpa again');
    expect(fakeBot.chat).toHaveBeenCalledTimes(1);
    state = manager.getState();
    expect(state.sessions[profile.id].events.some((event) => event.type === 'autoReply' && event.label === 'Auto response cooled down')).toBe(true);

    vi.setSystemTime(new Date('2026-06-25T10:00:06Z'));
    fakeBot.emit('chat', testUsername, 'tpa self message');
    fakeBot.emit('chat', 'Friend', 'tpa after cooldown');
    expect(fakeBot.chat).toHaveBeenCalledTimes(2);
  });
});

const cactusConfig: CactusFarmConfig = {
  enabled: true,
  layers: 1,
  radius: 2,
  placementDelayMs: 100,
  build: true,
  breakBlock: 'oak_fence',
  buildCollection: true
};

const cropConfig: CropFarmConfig = {
  enabled: true,
  crop: 'wheat',
  radius: 4,
  harvestDelayMs: 100,
  replant: true,
  collectDrops: true,
  build: true,
  autoTill: true,
  waterMode: 'auto'
};

const posKey = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;

describe('cactusFarmPlan', () => {
  const origin = { x: 0, y: 70, z: 0 };
  const plan = cactusFarmPlan(origin, cactusConfig);
  const places = plan.filter((item) => item.action === 'place');
  const cacti = places.filter((item) => item.itemName === 'cactus');
  const placedSet = new Set(places.map((item) => posKey(item.position)));

  it('puts a break trigger one block above each cactus, horizontally adjacent to the grow cell', () => {
    expect(cacti.length).toBeGreaterThan(0);
    for (const cactus of cacti) {
      const grow = { x: cactus.position.x, y: cactus.position.y + 1, z: cactus.position.z };
      const hasTrigger = places.some(
        (item) =>
          item.itemName === cactusConfig.breakBlock &&
          item.position.y === grow.y &&
          Math.abs(item.position.x - grow.x) + Math.abs(item.position.z - grow.z) === 1
      );
      expect(hasTrigger).toBe(true);
    }
  });

  it('keeps the cactus own level clear of solid neighbours so it never self-breaks', () => {
    for (const cactus of cacti) {
      const neighbours = [
        { x: cactus.position.x + 1, y: cactus.position.y, z: cactus.position.z },
        { x: cactus.position.x - 1, y: cactus.position.y, z: cactus.position.z },
        { x: cactus.position.x, y: cactus.position.y, z: cactus.position.z + 1 },
        { x: cactus.position.x, y: cactus.position.y, z: cactus.position.z - 1 }
      ];
      for (const n of neighbours) {
        expect(placedSet.has(posKey(n))).toBe(false);
      }
    }
  });

  it('spaces cacti at least two blocks apart', () => {
    for (let i = 0; i < cacti.length; i += 1) {
      for (let j = i + 1; j < cacti.length; j += 1) {
        const a = cacti[i].position;
        const b = cacti[j].position;
        const chebyshev = Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
        expect(chebyshev).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('orders the queue so every block is placed after its support (sand before its cactus)', () => {
    for (const cactus of cacti) {
      const sandPos = { x: cactus.position.x, y: cactus.position.y - 1, z: cactus.position.z };
      const sandIdx = plan.findIndex((item) => item.itemName === 'sand' && posKey(item.position) === posKey(sandPos));
      const cactusIdx = plan.indexOf(cactus);
      expect(sandIdx).toBeGreaterThanOrEqual(0);
      expect(sandIdx).toBeLessThan(cactusIdx);
    }
    // exactly one trigger per cactus (the +Z grow-cell neighbour at cactus.y + 1)
    const triggers = places.filter((item) =>
      item.itemName === cactusConfig.breakBlock &&
      cacti.some(
        (c) => c.position.x === item.position.x && item.position.z === c.position.z + 1 && item.position.y === c.position.y + 1
      )
    );
    expect(triggers.length).toBe(cacti.length);
  });

  it('counts materials: sand and cactus per unit, 4 break-blocks per unit, a hopper per unit', () => {
    const count = (name: string) => places.filter((item) => item.itemName === name).length;
    const units = cacti.length;
    expect(count('sand')).toBe(units);
    expect(count('cactus')).toBe(units);
    expect(count('oak_fence')).toBe(units * 4); // 3 post + 1 trigger
    expect(count('hopper')).toBe(units);
  });
});

describe('cropBuildPlan', () => {
  const origin = { x: 0, y: 70, z: 0 };
  const plan = cropBuildPlan(origin, cropConfig);

  it('covers a 9x9 footprint with water at the centre and a seed on every other cell', () => {
    expect(plan.footprint.length).toBe(81);
    expect(posKey(plan.waterPos)).toBe(posKey({ x: 0, y: 69, z: 0 }));
    expect(plan.plant.length).toBe(80);
    expect(plan.plant.every((item) => item.itemName === 'wheat_seeds')).toBe(true);
  });

  it('tills every planted cell (clear + till) before it is planted', () => {
    const tills = plan.prepare.filter((item) => item.action === 'till');
    expect(tills.length).toBe(plan.plant.length);
    // each till targets the farmland directly under its seed
    for (const seed of plan.plant) {
      const farmland = { x: seed.position.x, y: seed.position.y - 1, z: seed.position.z };
      expect(tills.some((item) => posKey(item.position) === posKey(farmland))).toBe(true);
    }
  });
});
