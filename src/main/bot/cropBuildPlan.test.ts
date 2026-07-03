import { describe, expect, it } from 'vitest';
import type { CropFarmConfig, PositionSnapshot } from '../../shared/types';
import { cropBuildPlan, waterAxis } from './botManager';

const ORIGIN: PositionSnapshot = { x: 0, y: 0, z: 0 };

function config(radius: number, overrides: Partial<CropFarmConfig> = {}): CropFarmConfig {
  return {
    enabled: true,
    crop: 'wheat',
    radius,
    harvestDelayMs: 750,
    replant: true,
    collectDrops: true,
    build: true,
    autoTill: true,
    waterMode: 'auto',
    ...overrides
  };
}

/** Chebyshev distance: hydration wets a 9x9 box = ±4 on each axis independently. */
function chebyshev(a: PositionSnapshot, b: PositionSnapshot): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

describe('waterAxis', () => {
  it('covers every cell within 4 blocks for radii 1..16 (Chebyshev)', () => {
    for (let half = 1; half <= 16; half += 1) {
      const sources = waterAxis(half);
      for (let c = -half; c <= half; c += 1) {
        const nearest = Math.min(...sources.map((s) => Math.abs(c - s)));
        expect(nearest, `half=${half} cell=${c} sources=${sources}`).toBeLessThanOrEqual(4);
      }
    }
  });

  it('uses a single centre source for small fields (radius <= 4)', () => {
    expect(waterAxis(1)).toEqual([0]);
    expect(waterAxis(4)).toEqual([0]);
  });
});

describe('cropBuildPlan', () => {
  it('builds a 7x7 field with one water source at radius 3', () => {
    const plan = cropBuildPlan(ORIGIN, config(3));
    expect(plan.footprint).toHaveLength(7 * 7);
    expect(plan.waterCells).toHaveLength(1);
    expect(plan.plant).toHaveLength(7 * 7 - 1);
  });

  it('keeps every planted cell hydrated for a large field (radius 8, Chebyshev <= 4)', () => {
    const plan = cropBuildPlan(ORIGIN, config(8));
    expect(plan.footprint).toHaveLength(17 * 17);
    for (const cell of plan.footprint) {
      const nearest = Math.min(...plan.waterCells.map((w) => chebyshev(cell, w)));
      expect(nearest, `cell=${cell.x},${cell.z}`).toBeLessThanOrEqual(4);
    }
    // Planted cells = footprint minus the water sources.
    expect(plan.plant).toHaveLength(plan.footprint.length - plan.waterCells.length);
  });

  it('clamps the radius to MAX_CROP_RADIUS (33x33 max)', () => {
    const plan = cropBuildPlan(ORIGIN, config(20));
    expect(plan.footprint).toHaveLength(33 * 33);
  });

  it('places water sources at farmland level (y-1)', () => {
    const plan = cropBuildPlan(ORIGIN, config(8));
    for (const w of plan.waterCells) expect(w.y).toBe(-1);
  });
});
