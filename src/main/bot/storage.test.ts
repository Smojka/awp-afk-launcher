import { describe, expect, it } from 'vitest';
import { normalizeStorage, shouldKeepItem, inventoryFillFraction } from './botManager';
import { defaultStorage } from './defaultProfiles';

const EDIBLE = new Set(['bread', 'cooked_beef', 'golden_apple']);
const item = (name: string) => ({ name });

describe('normalizeStorage (migration)', () => {
  it('fills full defaults for an old profile with no storage field', () => {
    expect(normalizeStorage(undefined)).toEqual(defaultStorage());
  });

  it('preserves and rounds captured chest coordinates', () => {
    const result = normalizeStorage({
      enabled: true,
      withdrawFrom: { x: 10.7, y: 64, z: -20.2 },
      depositTo: { x: 12, y: 65, z: -20 }
    });
    expect(result.enabled).toBe(true);
    expect(result.withdrawFrom).toEqual({ x: 11, y: 64, z: -20 });
    expect(result.depositTo).toEqual({ x: 12, y: 65, z: -20 });
  });

  it('clamps out-of-range tunables back into their safe bands', () => {
    const result = normalizeStorage({
      depositAtPercentFull: 2, // above 0.95
      keepSeedStacks: 99, // above 5
      retryAttempts: 0 // below 1
    });
    expect(result.depositAtPercentFull).toBe(0.95);
    expect(result.keepSeedStacks).toBe(5);
    expect(result.retryAttempts).toBe(1);
  });

  it('falls back to defaults for malformed coordinates', () => {
    const result = normalizeStorage({ depositTo: { x: NaN as unknown as number, y: 5, z: 'nope' as unknown as number } });
    const d = defaultStorage();
    expect(result.depositTo).toEqual({ x: d.depositTo.x, y: 5, z: d.depositTo.z });
  });
});

describe('shouldKeepItem (deposit keep-list)', () => {
  it('keeps every tool, bucket, and edible', () => {
    for (const name of ['iron_hoe', 'diamond_axe', 'stone_pickaxe', 'iron_shovel', 'netherite_sword']) {
      expect(shouldKeepItem(item(name), null, EDIBLE), name).toBe(true);
    }
    for (const name of ['bucket', 'water_bucket', 'lava_bucket', 'milk_bucket']) {
      expect(shouldKeepItem(item(name), null, EDIBLE), name).toBe(true);
    }
    expect(shouldKeepItem(item('bread'), null, EDIBLE)).toBe(true);
    expect(shouldKeepItem(item('golden_apple'), null, EDIBLE)).toBe(true);
  });

  it('deposits generic harvest/loot when no seed is active', () => {
    expect(shouldKeepItem(item('cobblestone'), null, EDIBLE)).toBe(false);
    expect(shouldKeepItem(item('cactus'), null, EDIBLE)).toBe(false);
    expect(shouldKeepItem(item('rotten_flesh'), null, EDIBLE)).toBe(false); // not in this server's food set
  });

  it('keeps the replant seed for self-seeding crops (carrot/potato are their own seed)', () => {
    expect(shouldKeepItem(item('carrot'), 'carrot', EDIBLE)).toBe(true);
    expect(shouldKeepItem(item('potato'), 'potato', EDIBLE)).toBe(true);
  });

  it('keeps wheat_seeds but deposits harvested wheat (split seed vs product)', () => {
    expect(shouldKeepItem(item('wheat_seeds'), 'wheat_seeds', EDIBLE)).toBe(true);
    expect(shouldKeepItem(item('wheat'), 'wheat_seeds', EDIBLE)).toBe(false);
  });
});

describe('inventoryFillFraction (deposit trigger)', () => {
  const botWith = (occupiedSlots: number) =>
    ({ inventory: { items: () => Array.from({ length: occupiedSlots }, () => item('cobblestone')) } }) as never;

  it('measures fill over the 36 main-storage slots', () => {
    expect(inventoryFillFraction(botWith(0))).toBe(0);
    expect(inventoryFillFraction(botWith(18))).toBeCloseTo(0.5, 5);
    expect(inventoryFillFraction(botWith(36))).toBe(1);
  });

  it('crosses the default 0.80 threshold between 28 and 29 occupied slots', () => {
    expect(inventoryFillFraction(botWith(28))).toBeLessThan(0.8);
    expect(inventoryFillFraction(botWith(29))).toBeGreaterThanOrEqual(0.8);
  });
});
