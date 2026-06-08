import { describe, it, expect } from 'vitest';
import { edgeStyle } from './value-color';

describe('edgeStyle', () => {
  it('maps each category to a color, label and value verb (color theme)', () => {
    expect(edgeStyle('solar-home', 'color').color).toBe('#16a34a');
    expect(edgeStyle('grid-home', 'color').color).toBe('#dc2626');
    expect(edgeStyle('solar-home', 'color').verb).toBe('saved');
    expect(edgeStyle('solar-export', 'color').verb).toBe('earned');
    expect(edgeStyle('grid-home', 'color').verb).toBe('spent');
    expect(edgeStyle('solar-home', 'color').label).toBe('Solar → Home');
  });

  it('mono theme collapses to black with a fill pattern flag', () => {
    const s = edgeStyle('solar-export', 'mono');
    expect(s.color).toBe('#000000');
    expect(typeof s.dashed).toBe('boolean');
  });
});
