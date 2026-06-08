import type { FlowModel } from '../flow-model';

export type SankeyTheme = 'color' | 'mono';

/** Pure: model + theme -> standalone SVG markup string. */
export type SankeyRenderer = (model: FlowModel, theme: SankeyTheme) => string;
