import 'dotenv/config';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { defaultRates, rateByLabel, ratesEffectiveOn, utilityNames } from '../src/lib/urdb/client';
import type { UrdbRate } from '../src/lib/urdb/types';

// The public DEMO_KEY is rate limited; set OPENEI_API_KEY for a full recording.
// Existing fixtures are kept; pass --all to re-record every one.
process.env.OPENEI_API_KEY ||= 'DEMO_KEY';
const directory = 'src/lib/urdb/__fixtures__';
const all = process.argv.includes('--all');
const utility = 'Wisconsin Electric Power Co';
const file = (name: string) => `${directory}/${name}.json`;
async function record<T>(name: string, fetch: () => Promise<T>): Promise<T> {
  if (!all && existsSync(file(name))) return JSON.parse(await readFile(file(name), 'utf8')) as T;
  const value = await fetch();
  await writeFile(file(name), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}
async function chainFrom(start: UrdbRate | null): Promise<UrdbRate[]> {
  const chain: UrdbRate[] = [];
  const seen = new Set<string>();
  let current = start;
  while (current && !seen.has(current.label) && chain.length < 80) {
    chain.push(current); seen.add(current.label);
    current = current.supersedes ? await rateByLabel(current.supersedes) : null;
  }
  return chain;
}
async function main(): Promise<void> {
  await mkdir(directory, { recursive: true });
  await record('utility-companies', () => utilityNames());
  const effective = await record('we-energies-effective-2026-04-28', () => ratesEffectiveOn(utility, '2026-04-28', 'America/Chicago'));
  await record('we-energies-defaults', () => defaultRates(utility));
  await record('pge-defaults', () => defaultRates('Pacific Gas & Electric Co'));
  await record('non-net-metering', async () => (await defaultRates('City of San Antonio, Texas (Utility Company)')).filter(rate => rate.dgrules && rate.dgrules !== 'Net Metering'));
  const single = (option: string) => effective.find(rate => rate.name.includes('Single-Phase') && rate.name.includes(`Option ${option}`)) ?? null;
  await record('we-energies-option-a-chain', async () => { const chain = await chainFrom(single('A')); if (!chain.length) throw new Error('We Energies Option A was not found'); return chain; });
  for (const date of ['2023-11-14', '2024-07-01', '2025-07-01', '2026-11-16']) {
    await record(`we-energies-effective-${date}`, () => ratesEffectiveOn(utility, date, 'America/Chicago'));
  }
  await record('we-energies-option-b-chain', async () => { const chain = await chainFrom(single('B')); if (!chain.length) throw new Error('We Energies Option B was not found'); return chain; });
}
main().catch(error => { console.error(error); process.exitCode = 1; });
