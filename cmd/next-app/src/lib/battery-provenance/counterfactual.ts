// counterfactual.ts
/**
 * The "solar, no battery" scenario for one interval: solar serves load first,
 * surplus exports, deficit imports. Energies in Wh. Plan-agnostic (no rates).
 */
export function solarOnlyNet(loadWh: number, solarWh: number): { importWh: number; exportWh: number } {
    const net = loadWh - solarWh;
    return net >= 0 ? { importWh: net, exportWh: 0 } : { importWh: 0, exportWh: -net };
}
