// counterfactual.test.ts
import { describe, it, expect } from 'vitest';
import { solarOnlyNet } from './counterfactual';

describe('solarOnlyNet', () => {
    it('imports when load exceeds solar', () => {
        expect(solarOnlyNet(500, 200)).toEqual({ importWh: 300, exportWh: 0 });
    });
    it('exports the surplus when solar exceeds load', () => {
        expect(solarOnlyNet(200, 500)).toEqual({ importWh: 0, exportWh: 300 });
    });
    it('is zero when balanced', () => {
        expect(solarOnlyNet(300, 300)).toEqual({ importWh: 0, exportWh: 0 });
    });
    it('treats missing/zero solar as full import', () => {
        expect(solarOnlyNet(400, 0)).toEqual({ importWh: 400, exportWh: 0 });
    });
});
