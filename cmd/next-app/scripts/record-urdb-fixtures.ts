import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { defaultRates, rateByLabel, ratesEffectiveOn, utilityNames } from '../src/lib/urdb/client';
import type { UrdbRate } from '../src/lib/urdb/types';

// The public DEMO_KEY is rate limited; set OPENEI_API_KEY for a full recording.
process.env.OPENEI_API_KEY ||= 'DEMO_KEY';
const directory = 'src/lib/urdb/__fixtures__';
async function save(name: string, value: unknown): Promise<void> {
  await writeFile(`${directory}/${name}.json`, `${JSON.stringify(value, null, 2)}\n`);
}
async function main(): Promise<void> {
  await mkdir(directory, { recursive: true });
  await save('utility-companies', await utilityNames());
  const effective = await ratesEffectiveOn('Wisconsin Electric Power Co', '2026-04-28', 'America/Chicago');
  await save('we-energies-effective-2026-04-28', effective);
  await save('we-energies-defaults', await defaultRates('Wisconsin Electric Power Co'));
  await save('pge-defaults', await defaultRates('Pacific Gas & Electric Co'));
  await save('non-net-metering', (await defaultRates('City of San Antonio, Texas (Utility Company)')).filter(rate => rate.dgrules && rate.dgrules !== 'Net Metering'));
  const chain: UrdbRate[] = [];
  let current = effective.find(rate => rate.name.includes('Single-Phase') && rate.name.includes('Option A')) ?? null;
  const seen = new Set<string>();
  while (current && !seen.has(current.label) && chain.length < 80) {
    chain.push(current); seen.add(current.label);
    current = current.supersedes ? await rateByLabel(current.supersedes) : null;
  }
  if (!chain.length) throw new Error('We Energies Option A was not found');
  await save('we-energies-option-a-chain', chain);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
