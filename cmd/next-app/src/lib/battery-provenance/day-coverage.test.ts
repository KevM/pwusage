import { describe, it, expect } from 'vitest';
import { classifyDayCoverage } from './day-coverage';

const day = { start: new Date('2026-01-02T00:00:00Z'), end: new Date('2026-01-03T00:00:00Z') };
const at = (h: number, m = 0) => new Date(`2026-01-02T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`).getTime();

describe('classifyDayCoverage', () => {
  it('empty when no samples', () => {
    expect(classifyDayCoverage([], day.start, day.end)).toBe('empty');
  });
  it('complete when samples span the whole day within threshold', () => {
    expect(classifyDayCoverage([at(0, 0), at(12), at(23, 55)], day.start, day.end)).toBe('complete');
  });
  it('partial when data stops mid-day (missingEnd)', () => {
    expect(classifyDayCoverage([at(0, 0), at(9)], day.start, day.end)).toBe('partial');
  });
  it('partial when data starts late (missingStart)', () => {
    expect(classifyDayCoverage([at(14), at(23, 55)], day.start, day.end)).toBe('partial');
  });
});
