import type { SystemCostDTO, SystemCostsDTO } from './tariff-contract';
import { addCalendarDays, siteLocalDateString, TariffValidationError } from './tariff-timeline';

export const SYSTEM_COST_COMPONENTS = ['solar', 'powerwall'] as const;
export type SystemCostComponent = (typeof SYSTEM_COST_COMPONENTS)[number];

/** A `null` component deletes that row. */
export type SystemCostsInput = Record<SystemCostComponent, SystemCostDTO | null>;

export interface SystemCostRow {
  component: string;
  install_date: string | null;
  price: string | number;
  tax_credit_percent: string | number | null;
  incentives: string | number;
}

const MAX_PRICE = 1_000_000;
const EARLIEST_INSTALL_DATE = '2000-01-01';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPONENT_LABEL: Record<SystemCostComponent, string> = { solar: 'Solar', powerwall: 'Powerwall' };

export function mapSystemCostRows(rows: SystemCostRow[]): Pick<SystemCostsDTO, 'solar' | 'powerwall'> {
  const toDTO = (component: SystemCostComponent): SystemCostDTO | null => {
    const row = rows.find(r => r.component === component);
    if (!row) return null;
    return {
      installDate: row.install_date ?? null,
      price: Number(row.price),
      taxCreditPercent: row.tax_credit_percent == null ? null : Number(row.tax_credit_percent),
      incentives: Number(row.incentives),
    };
  };
  return { solar: toDTO('solar'), powerwall: toDTO('powerwall') };
}

export function parseSystemCostsInput(body: unknown): SystemCostsInput {
  if (!isRecord(body)) throw new TariffValidationError('System costs must be an object');
  return {
    solar: parseComponent(body, 'solar'),
    powerwall: parseComponent(body, 'powerwall'),
  };
}

function parseComponent(body: Record<string, unknown>, component: SystemCostComponent): SystemCostDTO | null {
  const value = body[component];
  if (value === null) return null;
  const label = COMPONENT_LABEL[component];
  if (!isRecord(value)) throw new TariffValidationError(`${label} costs must be an object or null`);

  const price = value.price;
  if (!isFiniteNumberIn(price, 0, MAX_PRICE)) {
    throw new TariffValidationError(`${label} price must be between 0 and ${MAX_PRICE.toLocaleString('en-US')}`);
  }
  const incentives = value.incentives ?? 0;
  if (!isFiniteNumberIn(incentives, 0, price)) {
    throw new TariffValidationError(`${label} incentives must be between 0 and the price`);
  }
  const taxCreditPercent = value.taxCreditPercent ?? null;
  if (taxCreditPercent !== null && !isFiniteNumberIn(taxCreditPercent, 0, 100)) {
    throw new TariffValidationError(`${label} tax credit must be between 0 and 100 percent`);
  }
  const installDate = value.installDate ?? null;
  if (installDate !== null && !isValidInstallDate(installDate)) {
    throw new TariffValidationError(`${label} install date must be a real date between ${EARLIEST_INSTALL_DATE} and tomorrow`);
  }
  return { installDate, price, taxCreditPercent, incentives };
}

/**
 * Site-local "today" is at most one calendar day ahead of UTC "today", so UTC today + 1 is a
 * safe upper bound without needing the site's timezone here.
 */
function isValidInstallDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return false;
  const latest = addCalendarDays(siteLocalDateString(new Date(), 'UTC'), 1);
  return value >= EARLIEST_INSTALL_DATE && value <= latest;
}

function isFiniteNumberIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
