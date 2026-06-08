import type { SankeyRenderer } from './types';
import { directRenderer } from './direct-renderer';

export const DEFAULT_RENDERER_ID = 'direct';

const REGISTRY: Record<string, SankeyRenderer> = {
  direct: directRenderer,
};

export const RENDERER_IDS = Object.keys(REGISTRY);

export function getRenderer(id: string | null | undefined): SankeyRenderer {
  return (id && REGISTRY[id]) || REGISTRY[DEFAULT_RENDERER_ID];
}
