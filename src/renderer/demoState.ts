import { DEFAULT_SETTINGS, type AccountProfile, type BotSessionSnapshot, type LauncherState } from '../shared/types';
import { DEFAULT_HEARTBEAT_MESSAGES } from '../shared/heartbeatMessages';

export const demoProfiles: AccountProfile[] = [
  {
    id: 'session-01',
    label: 'ARKONAS_SMP',
    username: '',
    host: 'play.arkonas.net',
    port: 25565,
    version: '1.20.1',
    authMode: 'offline',
    enabled: true,
    startup: {
      enabled: true,
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
      swingArm: true,
      chatHeartbeat: false,
      autoRespawn: true,
      autoEat: true,
      eatAtFood: 14,
      pauseAtFood: 6,
      intervalMs: 18000,
      jitterPercent: 35,
      chatMessages: [...DEFAULT_HEARTBEAT_MESSAGES]
    },
    reconnect: {
      enabled: true,
      maxAttempts: 8,
      baseDelayMs: 5000,
      maxDelayMs: 90000
    }
  },
  {
    id: 'session-02',
    label: 'SESSION_02',
    username: '',
    host: 'localhost',
    port: 25565,
    version: false,
    authMode: 'offline',
    enabled: false,
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
      sneakPulse: true,
      swingArm: false,
      chatHeartbeat: true,
      autoRespawn: true,
      autoEat: true,
      eatAtFood: 14,
      pauseAtFood: 6,
      intervalMs: 24000,
      jitterPercent: 45,
      chatMessages: DEFAULT_HEARTBEAT_MESSAGES.slice(0, 6)
    },
    reconnect: {
      enabled: true,
      maxAttempts: 4,
      baseDelayMs: 8000,
      maxDelayMs: 120000
    }
  }
];

export function createDemoState(): LauncherState {
  const sessions: Record<string, BotSessionSnapshot> = {
    'session-01': {
      profileId: 'session-01',
      state: 'online',
      statusMessage: 'Online',
      ping: 24,
      health: 20,
      food: 18,
      position: { x: 124.5, y: 64, z: -812.3, yaw: 0.4, pitch: -0.1 },
      dimension: 'overworld',
      inventoryUsed: 24,
      inventorySize: 46,
      playersOnline: 38,
      startupActive: false,
      routineActive: true,
      connectedAt: new Date(Date.now() - 1000 * 60 * 28).toISOString(),
      nextReconnectAt: null,
      lastError: null,
      reconnectAttempts: 0,
      events: [
        event('session-01', 'jump', 'ok', 'Jump pulse', '240ms'),
        event('session-01', 'look', 'ok', 'Look pulse', 'Randomized view angle'),
        event('session-01', 'chat', 'info', 'Server message', 'Welcome back'),
        event('session-01', 'system', 'ok', 'Joined server', 'play.arkonas.net')
      ],
      chat: [
        line('session-01-c1', 'system', 'Microsoft login restored.'),
        line('session-01-c2', 'system', 'Joined play.arkonas.net.'),
        line('session-01-c3', 'server', 'Welcome back.')
      ]
    },
    'session-02': {
      profileId: 'session-02',
      state: 'offline',
      statusMessage: 'Stopped',
      ping: null,
      health: null,
      food: null,
      position: null,
      dimension: null,
      inventoryUsed: null,
      inventorySize: 46,
      playersOnline: null,
      startupActive: false,
      routineActive: false,
      connectedAt: null,
      nextReconnectAt: null,
      lastError: null,
      reconnectAttempts: 0,
      events: [event('session-02', 'system', 'muted', 'Session ready')],
      chat: [line('session-02-c1', 'system', 'Session is ready.')]
    }
  };

  return {
    profiles: demoProfiles,
    sessions,
    selectedProfileId: 'session-01',
    settings: { ...DEFAULT_SETTINGS, defaultReconnect: { ...DEFAULT_SETTINGS.defaultReconnect } },
    runtime: {
      appVersion: '0.1.0',
      systemState: 'online',
      botCount: 2,
      onlineCount: 1,
      authSessionDir: 'AppData/Roaming/ChunkKeeper/minecraft-auth-cache',
      estimatedRamMb: 220,
      latestError: null
    }
  };
}

function event(
  profileId: string,
  type: BotSessionSnapshot['events'][number]['type'],
  tone: BotSessionSnapshot['events'][number]['tone'],
  label: string,
  detail?: string
): BotSessionSnapshot['events'][number] {
  return {
    id: `${profileId}-${type}-${label}`,
    profileId,
    type,
    tone,
    label,
    detail,
    at: new Date().toISOString()
  };
}

function line(id: string, source: BotSessionSnapshot['chat'][number]['source'], message: string): BotSessionSnapshot['chat'][number] {
  return {
    id,
    source,
    message,
    at: new Date().toISOString()
  };
}
