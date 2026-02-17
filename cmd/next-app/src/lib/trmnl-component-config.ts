export type TrmnlBatterySocMode = 'glyph' | 'chart';

export interface TrmnlComponentConfig {
    showLiveGrid: boolean;
    showLiveSolar: boolean;
    showLiveBattery: boolean;
    showEnergyChart: boolean;
    showBatterySoc: boolean;
    showEstimatedBill: boolean;
    batterySocMode: TrmnlBatterySocMode;
}

export interface TrmnlComponentScreen {
    id: string;
    name: string;
    componentConfig: TrmnlComponentConfig;
}

export const MAX_TRMNL_COMPONENT_SCREENS = 3;

export const DEFAULT_TRMNL_COMPONENT_CONFIG: TrmnlComponentConfig = {
    showLiveGrid: true,
    showLiveSolar: true,
    showLiveBattery: true,
    showEnergyChart: true,
    showBatterySoc: true,
    showEstimatedBill: true,
    batterySocMode: 'glyph'
};

function asRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                return parsed as Record<string, unknown>;
            }
        } catch {
            return null;
        }
    }

    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    return value as Record<string, unknown>;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function asBatterySocMode(value: unknown, fallback: TrmnlBatterySocMode): TrmnlBatterySocMode {
    return value === 'glyph' || value === 'chart' ? value : fallback;
}

function fromKeys(record: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
        if (key in record) return record[key];
    }
    return undefined;
}

function normalizeScreenName(value: unknown, index: number): string {
    if (typeof value !== 'string') return `Screen ${index + 1}`;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : `Screen ${index + 1}`;
}

function normalizeScreenId(value: unknown, index: number): string {
    if (typeof value !== 'string') return `screen-${index + 1}`;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : `screen-${index + 1}`;
}

export function normalizeTrmnlComponentConfig(value: unknown): TrmnlComponentConfig {
    const rawRecord = asRecord(value);
    if (!rawRecord) {
        return { ...DEFAULT_TRMNL_COMPONENT_CONFIG };
    }

    const nested = asRecord(rawRecord.component_config);
    const record = nested ?? rawRecord;

    return {
        showLiveGrid: asBoolean(fromKeys(record, ['showLiveGrid', 'show_live_grid']), DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveGrid),
        showLiveSolar: asBoolean(fromKeys(record, ['showLiveSolar', 'show_live_solar']), DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveSolar),
        showLiveBattery: asBoolean(fromKeys(record, ['showLiveBattery', 'show_live_battery']), DEFAULT_TRMNL_COMPONENT_CONFIG.showLiveBattery),
        showEnergyChart: asBoolean(fromKeys(record, ['showEnergyChart', 'show_energy_chart']), DEFAULT_TRMNL_COMPONENT_CONFIG.showEnergyChart),
        showBatterySoc: asBoolean(fromKeys(record, ['showBatterySoc', 'show_battery_soc']), DEFAULT_TRMNL_COMPONENT_CONFIG.showBatterySoc),
        showEstimatedBill: asBoolean(fromKeys(record, ['showEstimatedBill', 'show_estimated_bill']), DEFAULT_TRMNL_COMPONENT_CONFIG.showEstimatedBill),
        batterySocMode: asBatterySocMode(fromKeys(record, ['batterySocMode', 'battery_soc_mode']), DEFAULT_TRMNL_COMPONENT_CONFIG.batterySocMode)
    };
}

export function buildDefaultTrmnlComponentScreens(): TrmnlComponentScreen[] {
    return [{
        id: 'screen-1',
        name: 'Screen 1',
        componentConfig: { ...DEFAULT_TRMNL_COMPONENT_CONFIG }
    }];
}

export function normalizeTrmnlComponentScreens(value: unknown): TrmnlComponentScreen[] {
    const rawRecord = asRecord(value);
    const rawScreens = Array.isArray(rawRecord?.component_screens)
        ? rawRecord.component_screens
        : (Array.isArray(value) ? value : null);

    if (rawScreens && rawScreens.length > 0) {
        const seenIds = new Set<string>();
        const normalized: TrmnlComponentScreen[] = [];
        for (let i = 0; i < rawScreens.length && normalized.length < MAX_TRMNL_COMPONENT_SCREENS; i++) {
            const raw = asRecord(rawScreens[i]);
            if (!raw) continue;
            const id = normalizeScreenId(raw.id, normalized.length);
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            normalized.push({
                id,
                name: normalizeScreenName(raw.name, normalized.length),
                componentConfig: normalizeTrmnlComponentConfig(raw.componentConfig ?? raw.component_config)
            });
        }
        if (normalized.length > 0) return normalized;
    }

    // Legacy / reset fallback: single screen using current normalized config.
    const fallbackConfig = normalizeTrmnlComponentConfig(rawRecord?.component_config ?? rawRecord);
    return [{
        id: 'screen-1',
        name: 'Screen 1',
        componentConfig: fallbackConfig
    }];
}

export function extractTrmnlComponentScreens(installationJson: unknown): TrmnlComponentScreen[] {
    return normalizeTrmnlComponentScreens(installationJson);
}

export function extractTrmnlCarouselIndex(installationJson: unknown, screenCount: number): number {
    if (screenCount <= 0) return 0;
    const record = asRecord(installationJson);
    const raw = record?.carousel_index;
    if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) {
        return raw % screenCount;
    }
    return 0;
}

export function mergeTrmnlComponentScreensIntoInstallationJson(
    installationJson: unknown,
    screens: TrmnlComponentScreen[],
    carouselIndex = 0
): Record<string, unknown> {
    const record = asRecord(installationJson) ?? {};
    const normalizedScreens = normalizeTrmnlComponentScreens(screens);
    const safeIndex = normalizedScreens.length > 0
        ? Math.max(0, Math.min(carouselIndex, normalizedScreens.length - 1))
        : 0;

    return {
        ...record,
        component_screens: normalizedScreens.map((screen) => ({
            id: screen.id,
            name: screen.name,
            component_config: screen.componentConfig
        })),
        carousel_index: safeIndex
    };
}

// Backward-compatible helpers for legacy single-screen call sites.
export function extractTrmnlComponentConfig(installationJson: unknown): TrmnlComponentConfig {
    return extractTrmnlComponentScreens(installationJson)[0]?.componentConfig ?? { ...DEFAULT_TRMNL_COMPONENT_CONFIG };
}

export function mergeTrmnlComponentConfigIntoInstallationJson(
    installationJson: unknown,
    componentConfig: TrmnlComponentConfig
): Record<string, unknown> {
    return mergeTrmnlComponentScreensIntoInstallationJson(installationJson, [{
        id: 'screen-1',
        name: 'Screen 1',
        componentConfig: normalizeTrmnlComponentConfig(componentConfig)
    }], 0);
}
