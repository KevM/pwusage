# Task Tracking for Site Data CQRS Refactor

## Completed Tasks

### Task 1-9: Completed
- [x] Task 1: Apply CQRS section headers to existing repos
- [x] Task 2: Fold UserRepo free functions into the class
- [x] Task 3: Add UserRepo `getById`, `upsertOnTeslaAuth`, `updateTokens`
- [x] Task 4: Add SiteRepo `assignSiteToUser`, `upsertSite`, `getSiteJson`
- [x] Task 5: Switch `profile/page.tsx` and `auth/tesla-callback/route.ts` to repos
- [x] Task 6: Create `TariffRepo`
- [x] Task 7: Refactor Importer `ensureSite` to use SiteRepo + TariffRepo
- [x] Task 8: Add `EnergyRepo.getLatestTimestamp` and `EnergyRepo.insertEnergyDataBatch`
- [x] Task 9: Refactor Importer day-loop to use `EnergyRepo.insertEnergyDataBatch`

### Additional Task 9b: Refactor Importer Bulk Insert
- [x] Remove `pool.connect` and transaction wrapping from `persistHistory` and `persistHistoryForRange`
- [x] Remove unused `insertEnergyData` method with tariff remapping
- [x] Add `tariff_schedule_id` to `EnergyDataRow` type
- [x] Update transformer to calculate and include `tariff_schedule_id`
- [x] Update all callers to pass `tariff_schedule_id`

## In Progress
- [ ] Task 10: Move `getInstallationAndSite` to `TrmnlInstallationRepo.findByUuidWithSite`
- [ ] Task 11: Route TeslaTokenRepo token writes through UserRepo
- [ ] Task 12: Cleanup verification + PR description
