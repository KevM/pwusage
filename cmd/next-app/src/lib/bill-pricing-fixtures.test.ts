import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BILL_PRICING_FIXTURE_CASES } from '../../scripts/bill-pricing-fixtures';
import { buildBillPricingFixture } from './bill-pricing-fixtures';

const FIXTURES_DIR = path.resolve(
  __dirname,
  '../../../ios-app/Packages/PWUsageCore/Tests/PWUsageCoreTests/Fixtures/BillPricing'
);

describe('bill-pricing-fixtures', () => {
  it('checked-in fixtures match the server engine', () => {
    expect(BILL_PRICING_FIXTURE_CASES).toHaveLength(10);

    for (const def of BILL_PRICING_FIXTURE_CASES) {
      const expected: unknown = JSON.parse(JSON.stringify(buildBillPricingFixture(def)));
      const filePath = path.join(FIXTURES_DIR, `${def.name}.json`);
      const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(parsed, `fixture ${def.name}.json`).toEqual(expected);
    }
  });
});
