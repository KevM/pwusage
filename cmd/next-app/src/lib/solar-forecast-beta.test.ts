import { describe, expect, it } from 'vitest';
import { hasSolarForecastBeta, SOLAR_FORECAST_BETA_ROLE } from './solar-forecast-beta';

describe('hasSolarForecastBeta', () => {
    it('is true only for the beta role', () => {
        expect(SOLAR_FORECAST_BETA_ROLE).toBe('solar-forecast-beta');
        expect(hasSolarForecastBeta(['solar-forecast-beta'])).toBe(true);
        expect(hasSolarForecastBeta(['admin'])).toBe(false);
        expect(hasSolarForecastBeta([])).toBe(false);
    });
});
