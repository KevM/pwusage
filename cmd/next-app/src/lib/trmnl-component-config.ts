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

export function extractTrmnlComponentConfig(installationJson: unknown): TrmnlComponentConfig {
    return normalizeTrmnlComponentConfig(installationJson);
}

export function mergeTrmnlComponentConfigIntoInstallationJson(
    installationJson: unknown,
    componentConfig: TrmnlComponentConfig
): Record<string, unknown> {
    const record = asRecord(installationJson) ?? {};
    return {
        ...record,
        component_config: componentConfig
    };
}
