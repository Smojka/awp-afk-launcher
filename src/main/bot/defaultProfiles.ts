import type { AccountProfile } from '../../shared/types.js';
import { DEFAULT_HEARTBEAT_MESSAGES } from '../../shared/heartbeatMessages.js';

const defaultRoutine = {
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
};

const defaultReconnect = {
  enabled: true,
  maxAttempts: 8,
  baseDelayMs: 5000,
  maxDelayMs: 90000
};

const defaultStartup = {
  enabled: false,
  authMode: 'login' as const,
  authCommandTemplate: '/login {password}',
  registerCommandTemplate: '/register {password} {password}',
  authPassword: '',
  authDelayMs: 2500,
  transferCommand: '/smp',
  transferDelayMs: 3500,
  flowCommands: []
};

const arkonasStartup = {
  ...defaultStartup,
  enabled: true
};

export function createDefaultProfiles(): AccountProfile[] {
  return [
    {
      id: 'session-01',
      label: 'ARKONAS_SMP',
      username: '',
      host: 'play.arkonas.net',
      port: 25565,
      version: '1.20.1',
      authMode: 'offline',
      enabled: true,
      startup: arkonasStartup,
      routine: defaultRoutine,
      reconnect: defaultReconnect
    }
  ];
}
