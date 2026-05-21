# Fix: Stale Tariff IDs in Energy Batch Insertion

## Problem

The `loadInterval` method in the Importer was directly forwarding `row.tariff_id` from `site.tariffs` to `insertEnergyDataBatch` without validating that the tariff IDs still exist in the database. This caused foreign key constraint violations when:

1. A tariff refresh runs (via `TariffRepo.replaceTariffsForSite`) between loading `site.tariffs` and inserting energy data
2. The tariff replacement deletes and recreates tariff rows with new IDs
3. The stale IDs from `site.tariffs` no longer match the DB's current tariff IDs

This is a classic race condition in concurrent workflows, where the sync operation reads site data with a snapshot of tariffs, but a concurrent `ensureSite` call can invalidate those IDs.

## Solution

Implemented tariff ID remapping logic similar to the old importer path that was removed during the decompose refactor. The fix:

1. **Fetch current DB tariffs** by site ID before inserting energy data
2. **Build remapping map** from stale tariff IDs to current DB tariff IDs
3. **Remap tariff IDs** by matching on tariff name (since names are stable across refreshes)
4. **Null out schedule IDs** for remapped rows (since schedule IDs are also invalidated)
5. **Skip rows** with unresolvable tariff IDs (cannot match stale ID to any current tariff)

## Implementation Details

### New Method: `remapTariffIds`

Added to `Importer` class in `src/lib/importer/index.ts`:

```typescript
private async remapTariffIds(
    siteId: string,
    rows: EnergyDataRow[],
    siteTariffs: Tariff[]
): Promise<EnergyDataRow[]>
```

The method:
- Fetches current DB tariffs via `TariffRepo.getTariffsForSite`
- Builds a name → ID map from DB tariffs
- Builds an ID → name map from site.tariffs (stale)
- Remaps stale IDs to current IDs by name matching
- Nulls out schedule IDs for remapped rows to maintain FK integrity
- Returns filtered rows with only valid tariff IDs

### Updated Methods

1. **`loadInterval`**: Now calls `remapTariffIds` before `insertEnergyDataBatch`
2. **`persistHistory`**: Also calls `remapTariffIds` before `insertEnergyDataBatch`

Both methods now:
- Log the number of rows remapped
- Only insert rows with valid tariff IDs
- Preserve schedule IDs when tariffs are unchanged

## Testing

Added comprehensive tests in `src/lib/importer.test.ts`:

1. **Remap stale tariff IDs**: Verifies IDs are correctly remapped when DB has different IDs
2. **Skip unresolvable rows**: Verifies rows with unknown tariffs are skipped
3. **Keep valid IDs unchanged**: Verifies rows with valid tariff IDs are unchanged

All 292 tests pass (38 test files).

## Benefits

1. **Prevents FK violations**: No more constraint errors from stale tariff IDs
2. **Concurrent workflow safe**: Handles race conditions between sync and tariff refresh
3. **Backward compatible**: Existing functionality unchanged for stable tariff IDs
4. **Better logging**: Logs remapping actions for debugging
5. **Consistent behavior**: Restores safeguard that was removed in the refactor

## Files Modified

- `src/lib/importer/index.ts`: Added remapping logic
- `src/lib/importer.test.ts`: Added tests for remapping functionality