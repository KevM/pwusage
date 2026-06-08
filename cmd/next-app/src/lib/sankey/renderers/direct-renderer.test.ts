import { describe, it, expect } from 'vitest';
import { directRenderer } from './direct-renderer';
import { buildSnapshotModel } from '../build-flow-model';

describe('directRenderer', () => {
  const model = buildSnapshotModel(
    { solar: 5, load: 6, battery: 2, grid: -1 },
    { buyRate: 0.40, sellRate: 0.10, timestamp: new Date('2026-06-08T18:00:00Z'), soc: 68 },
  );

  it('returns an svg string with one ribbon path per edge', () => {
    const svg = directRenderer(model, 'color');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
    const ribbons = (svg.match(/class="ribbon"/g) || []).length;
    expect(ribbons).toBe(model.edges.length);
  });

  it('includes node labels and battery soc', () => {
    const svg = directRenderer(model, 'color');
    expect(svg).toContain('SOLAR');
    expect(svg).toContain('HOME');
    expect(svg).toContain('68%');
  });

  it('emits a <title> tooltip with value verb per ribbon', () => {
    const svg = directRenderer(model, 'color');
    expect(svg).toContain('saved');   // solar-home / battery-home
    expect(svg).toContain('<title>');
  });

  it('uses black ribbons under the mono theme', () => {
    const svg = directRenderer(model, 'mono');
    expect(svg).toContain('#000000');
    expect(svg).not.toContain('#16a34a');
  });

  it('uses plain-text node labels (no emoji) under the mono theme', () => {
    const svg = directRenderer(model, 'mono');
    expect(svg).toContain('SOLAR');
    expect(svg).toContain('HOME');
    expect(svg).not.toContain('☀️');
    expect(svg).not.toContain('🏠');
    expect(svg).not.toContain('🔋');
    expect(svg).not.toContain('🔌');
  });

  it('keeps emoji node labels under the color theme', () => {
    const svg = directRenderer(model, 'color');
    expect(svg).toContain('☀️');
  });

  it('emits preserveAspectRatio so the section can scale it to fit', () => {
    const svg = directRenderer(model, 'mono');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
  });
});
