import { afterEach, describe, expect, it, vi } from 'vitest';
import { AfkRoutine, calculateRoutineDelay, chooseRoutineActions, type RoutineBot } from './afkRoutine';
import { DEFAULT_HEARTBEAT_MESSAGES } from '../../shared/heartbeatMessages';
import type { AfkRoutineConfig } from '../../shared/types';

const baseConfig: AfkRoutineConfig = {
  randomLook: true,
  autoJump: true,
  sneakPulse: false,
  swingArm: true,
  chatHeartbeat: false,
  autoRespawn: true,
  autoEat: true,
  eatAtFood: 14,
  pauseAtFood: 6,
  intervalMs: 10000,
  jitterPercent: 20,
  chatMessages: DEFAULT_HEARTBEAT_MESSAGES
};

afterEach(() => {
  vi.useRealTimers();
});

describe('AFK routine timing', () => {
  it('keeps randomized delays inside the configured jitter window', () => {
    expect(calculateRoutineDelay(10000, 20, () => 0)).toBe(8000);
    expect(calculateRoutineDelay(10000, 20, () => 0.5)).toBe(10000);
    expect(calculateRoutineDelay(10000, 20, () => 1)).toBe(12000);
  });

  it('clamps unsafe interval and jitter values', () => {
    expect(calculateRoutineDelay(100, 120, () => 0)).toBeGreaterThanOrEqual(1500);
    expect(calculateRoutineDelay(3000, -10, () => 0)).toBe(3000);
  });
});

describe('AFK routine action plan', () => {
  it('keeps default chat messages varied and human-readable', () => {
    expect(DEFAULT_HEARTBEAT_MESSAGES.length).toBeGreaterThanOrEqual(24);
    expect(new Set(DEFAULT_HEARTBEAT_MESSAGES).size).toBe(DEFAULT_HEARTBEAT_MESSAGES.length);
    for (const message of DEFAULT_HEARTBEAT_MESSAGES) {
      expect(message).not.toMatch(/\b(bot|yapay zeka|ai|otomatik|heartbeat)\b/i);
      expect(message).not.toMatch(/^\s*$/);
    }
  });

  it('only schedules AFK-scoped actions enabled by the profile', () => {
    expect(chooseRoutineActions(baseConfig)).toEqual(['look', 'jump', 'swing']);
    expect(chooseRoutineActions({ ...baseConfig, chatHeartbeat: true })).toEqual(['look', 'jump', 'swing', 'chat']);
  });

  it('runs look, swing, sneak, and chat routine actions through the bot API', () => {
    vi.useFakeTimers();
    const look = vi.fn();
    const swingArm = vi.fn();
    const setControlState = vi.fn();
    const chat = vi.fn();
    const emitEvent = vi.fn();

    const lookRoutine = new AfkRoutine(
      'session-01',
      { look },
      { ...baseConfig, autoJump: false, swingArm: false },
      { emitEvent },
      () => 0.5
    );
    lookRoutine.start();
    vi.advanceTimersByTime(10000);
    expect(look).toHaveBeenCalledWith(Math.PI, 0, true);
    lookRoutine.stop();

    const swingRoutine = new AfkRoutine(
      'session-01',
      { swingArm },
      { ...baseConfig, randomLook: false, autoJump: false },
      { emitEvent },
      () => 0.5
    );
    swingRoutine.start();
    vi.advanceTimersByTime(10000);
    expect(swingArm).toHaveBeenCalledWith('right');
    swingRoutine.stop();

    const sneakRoutine = new AfkRoutine(
      'session-01',
      { setControlState },
      { ...baseConfig, randomLook: false, autoJump: false, swingArm: false, sneakPulse: true },
      { emitEvent },
      () => 0.5
    );
    sneakRoutine.start();
    vi.advanceTimersByTime(10000);
    expect(setControlState).toHaveBeenCalledWith('sneak', true);
    vi.advanceTimersByTime(420);
    expect(setControlState).toHaveBeenCalledWith('sneak', false);
    sneakRoutine.stop();

    const chatRoutine = new AfkRoutine(
      'session-01',
      { chat },
      { ...baseConfig, randomLook: false, autoJump: false, swingArm: false, chatHeartbeat: true },
      { emitEvent },
      () => 0.5
    );
    chatRoutine.start();
    vi.advanceTimersByTime(10000);
    expect(chat).toHaveBeenCalledWith(DEFAULT_HEARTBEAT_MESSAGES[Math.floor(0.5 * DEFAULT_HEARTBEAT_MESSAGES.length)]);
    chatRoutine.stop();
  });

  it('pulses bot controls and emits a timeline event', () => {
    vi.useFakeTimers();
    const setControlState = vi.fn();
    const emitEvent = vi.fn();
    const bot: RoutineBot = { setControlState };
    const routine = new AfkRoutine('session-01', bot, { ...baseConfig, randomLook: false, swingArm: false }, { emitEvent }, () => 0.5);

    routine.start();
    vi.advanceTimersByTime(10000);

    expect(setControlState).toHaveBeenCalledWith('jump', true);
    expect(emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'jump', label: 'Jump pulse' }));

    vi.advanceTimersByTime(240);
    expect(setControlState).toHaveBeenCalledWith('jump', false);
    routine.stop();
  });

  it('avoids repeating the same chat message back-to-back when alternatives exist', () => {
    vi.useFakeTimers();
    const chat = vi.fn();
    const routine = new AfkRoutine(
      'session-01',
      { chat },
      {
        ...baseConfig,
        randomLook: false,
        autoJump: false,
        swingArm: false,
        chatHeartbeat: true,
        intervalMs: 10000,
        jitterPercent: 0,
        chatMessages: ['buradayım', 'takipteyim']
      },
      { emitEvent: vi.fn() },
      () => 0
    );

    routine.start();
    vi.advanceTimersByTime(10000);
    vi.advanceTimersByTime(10000);

    expect(chat).toHaveBeenNthCalledWith(1, 'buradayım');
    expect(chat).toHaveBeenNthCalledWith(2, 'takipteyim');
    routine.stop();
  });
});
