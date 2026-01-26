import { describe, it, expect } from 'vitest';
import { detectLoads } from './load-detection';
import { PowerData } from './types';

// Helper to create mock power data
function createPowerData(timestamp: string, watts: number): PowerData {
    return {
        timestamp: new Date(timestamp),
        powerWatts: watts,
        tariffId: 1,
    };
}

describe('detectLoads', () => {
    it('returns empty array for empty input', () => {
        const result = detectLoads([], 1000);
        expect(result).toEqual([]);
    });

    it('returns empty array if load is always below threshold', () => {
        const data = [
            createPowerData('2023-01-01T10:00:00Z', 500),
            createPowerData('2023-01-01T10:05:00Z', 500),
            createPowerData('2023-01-01T10:10:00Z', 500),
            createPowerData('2023-01-01T10:15:00Z', 500),
            createPowerData('2023-01-01T10:20:00Z', 500),
        ];
        const result = detectLoads(data, 1000);
        expect(result).toEqual([]);
    });

    it('detects a single simple event', () => {
        // 500W base -> 2000W load -> 500W base
        const data = [
            // Pre-window
            createPowerData('2023-01-01T10:00:00Z', 500),
            createPowerData('2023-01-01T10:05:00Z', 500),
            createPowerData('2023-01-01T10:10:00Z', 500),

            // Start of event 10:15 (Index 3)
            createPowerData('2023-01-01T10:15:00Z', 2000),
            createPowerData('2023-01-01T10:20:00Z', 2100), // Max
            createPowerData('2023-01-01T10:25:00Z', 1900), // Min

            createPowerData('2023-01-01T10:30:00Z', 2000),
            createPowerData('2023-01-01T10:35:00Z', 2000),

            // End at 10:40 (Index 8)
            createPowerData('2023-01-01T10:40:00Z', 500),
            createPowerData('2023-01-01T10:45:00Z', 500),
            createPowerData('2023-01-01T10:50:00Z', 500),
            createPowerData('2023-01-01T10:55:00Z', 500),
        ];

        const result = detectLoads(data, 1000);

        expect(result).toHaveLength(1);
        expect(result[0].startTime).toEqual(new Date('2023-01-01T10:15:00Z'));
        expect(result[0].endTime).toEqual(new Date('2023-01-01T10:40:00Z'));

        expect(result[0].durationMinutes).toBe(25);
        expect(result[0].maxPower).toBe(2100);
        expect(result[0].minPower).toBe(1900);
    });

    it('captures the tariff ID from the start of the event', () => {
        const data = [
            createPowerData('2023-01-01T10:00:00Z', 500),
            createPowerData('2023-01-01T10:05:00Z', 500),
            createPowerData('2023-01-01T10:10:00Z', 500),

            { ...createPowerData('2023-01-01T10:15:00Z', 2000), tariffId: 2 },
            { ...createPowerData('2023-01-01T10:20:00Z', 2000), tariffId: 2 },
            { ...createPowerData('2023-01-01T10:25:00Z', 2000), tariffId: 2 },

            createPowerData('2023-01-01T10:30:00Z', 500),
            createPowerData('2023-01-01T10:35:00Z', 500),
            createPowerData('2023-01-01T10:40:00Z', 500),
        ];

        const result = detectLoads(data, 1000);
        expect(result).toHaveLength(1);
        expect(result[0].tariffId).toBe(2);
    });
});
