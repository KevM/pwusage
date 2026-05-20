import type { TrmnlSection } from './types';
import { liveSection } from './live';
import { energyChartSection } from './energy-chart';
import { socSection } from './soc';
import { billSection } from './bill';
import { loadTimingSection } from './load-timing';

export const SECTION_REGISTRY: TrmnlSection[] = [
    liveSection,
    energyChartSection,
    socSection,
    billSection,
    loadTimingSection
];
