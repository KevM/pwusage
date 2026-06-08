import type { EdgeCategory } from './flow-model';
import type { SankeyTheme } from './renderers/types';

export type ValueVerb = 'saved' | 'earned' | 'spent';

export interface EdgeStyle {
  color: string;
  label: string;
  verb: ValueVerb;
  dashed: boolean; // mono-theme texture hint for sell-rate / export flows
}

interface Spec {
  color: string;
  label: string;
  verb: ValueVerb;
}

const SPECS: Record<EdgeCategory, Spec> = {
  'solar-home':    { color: '#16a34a', label: 'Solar → Home',     verb: 'saved' },
  'solar-battery': { color: '#0d9488', label: 'Solar → Battery',  verb: 'saved' },
  'solar-export':  { color: '#d97706', label: 'Solar → Grid',     verb: 'earned' },
  'battery-home':  { color: '#2563eb', label: 'Battery → Home',   verb: 'saved' },
  'grid-home':     { color: '#dc2626', label: 'Grid → Home',      verb: 'spent' },
  'grid-battery':  { color: '#991b1b', label: 'Grid → Battery',   verb: 'spent' },
  'battery-export':{ color: '#d97706', label: 'Battery → Grid',   verb: 'earned' },
};

export function edgeStyle(category: EdgeCategory, theme: SankeyTheme): EdgeStyle {
  const spec = SPECS[category];
  const dashed = spec.verb === 'earned';
  return {
    color: theme === 'mono' ? '#000000' : spec.color,
    label: spec.label,
    verb: spec.verb,
    dashed,
  };
}
