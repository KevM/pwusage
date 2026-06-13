import { describe, it, expect } from 'vitest';
import { EMPTY_TANK, chargeTank, dischargeTank } from './tank';

describe('tank', () => {
    it('charges grid at buy rate and solar at sell rate ($/kWh, energy Wh)', () => {
        let t = chargeTank(EMPTY_TANK, 0, 4000, 0.11, 0.04);   // 4 kWh grid @ $0.11
        t = chargeTank(t, 5000, 0, 0.11, 0.04);                // 5 kWh solar @ $0.04
        expect(t.gridWh).toBe(4000);
        expect(t.solarWh).toBe(5000);
        expect(t.gridCost).toBeCloseTo(0.44, 6);
        expect(t.solarCost).toBeCloseTo(0.20, 6);
    });

    it('discharges proportionally, preserving ratio and drawing cost pro-rata', () => {
        let t = chargeTank(EMPTY_TANK, 0, 4000, 0.11, 0.04);
        t = chargeTank(t, 5000, 0, 0.11, 0.04);                // tank: 9 kWh, $0.64
        const { tank, draw } = dischargeTank(t, 4500);         // draw half
        expect(draw.solarWh).toBeCloseTo(2500, 6);
        expect(draw.gridWh).toBeCloseTo(2000, 6);
        expect(draw.solarCost + draw.gridCost).toBeCloseTo(0.32, 6);
        expect(tank.solarWh).toBeCloseTo(2500, 6);
        expect(tank.gridWh).toBeCloseTo(2000, 6);
    });

    it('is a no-op when discharging an empty tank', () => {
        const { tank, draw } = dischargeTank(EMPTY_TANK, 1000);
        expect(draw).toEqual({ solarWh: 0, gridWh: 0, solarCost: 0, gridCost: 0 });
        expect(tank).toEqual(EMPTY_TANK);
    });

    it('caps the draw at what is in the tank', () => {
        const t = chargeTank(EMPTY_TANK, 1000, 0, 0.11, 0.04); // 1 kWh solar
        const { tank, draw } = dischargeTank(t, 5000);         // ask for more than available
        expect(draw.solarWh).toBeCloseTo(1000, 6);
        expect(tank.solarWh).toBeCloseTo(0, 6);
    });
});
