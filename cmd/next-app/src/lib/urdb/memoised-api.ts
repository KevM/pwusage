import * as urdb from './client';
import type { UrdbApi } from './estimate-job';

// Memoised per request: each date and label is fetched at most once.
export function memoisedApi(client: UrdbApi = urdb): UrdbApi {
  const effective = new Map<string, ReturnType<UrdbApi['ratesEffectiveOn']>>();
  const labels = new Map<string, ReturnType<UrdbApi['rateByLabel']>>();
  return {
    ratesEffectiveOn: (utility: string, date: string, zone: string) => {
      const key = JSON.stringify([utility, date, zone]);
      let value = effective.get(key);
      if (!value) { value = client.ratesEffectiveOn(utility, date, zone); effective.set(key, value); }
      return value;
    },
    rateByLabel: (label: string) => {
      let value = labels.get(label);
      if (!value) { value = client.rateByLabel(label); labels.set(label, value); }
      return value;
    },
    defaultRates: (utility: string) => client.defaultRates(utility),
    utilityNames: () => client.utilityNames(),
  };
}
