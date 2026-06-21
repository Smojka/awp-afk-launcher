import { describe, expect, it } from 'vitest';
import { createDefaultProfiles } from './defaultProfiles';

describe('createDefaultProfiles', () => {
  it('opens with an Arkonas SMP profile ready for lobby auth transfer', () => {
    const profiles = createDefaultProfiles();
    const [profile] = profiles;

    expect(profiles).toHaveLength(1);
    expect(profile).toMatchObject({
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
        transferCommand: '/smp'
      }
    });
    expect(profiles.some((candidate) => candidate.host === 'localhost')).toBe(false);
  });
});
