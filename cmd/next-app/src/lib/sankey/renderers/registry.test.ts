import { describe, it, expect } from 'vitest';
import { getRenderer, DEFAULT_RENDERER_ID, RENDERER_IDS } from './registry';
import { directRenderer } from './direct-renderer';

describe('renderer registry', () => {
  it('resolves the direct renderer by id', () => {
    expect(getRenderer('direct')).toBe(directRenderer);
  });
  it('falls back to the default for unknown/null ids', () => {
    expect(getRenderer(null)).toBe(directRenderer);
    expect(getRenderer('nope')).toBe(directRenderer);
    expect(DEFAULT_RENDERER_ID).toBe('direct');
  });
  it('exposes the list of registered ids', () => {
    expect(RENDERER_IDS).toContain('direct');
  });
});
