package fleetdb

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestUsage_GetUsages(t *testing.T) {
	siteid := "2252268092126997"
	var err error
	db, client, logger, err := Setup("./pw-testing.db")
	require.NoError(t, err)

	defer db.DeleteDb()

	er := NewEnergyRepo(db, logger)
	site, err := er.LoadSite(siteid, client)
	require.NoError(t, err)

	sod := time.Date(2024, 5, 1, 0, 0, 0, 0, site.Location)
	eod := time.Date(2024, 5, 2, 0, 0, 0, 0, site.Location)

	importer := NewImporter(client, logger)
	err = importer.LoadSiteHistoryDay(db, sod, site)
	require.NoError(t, err)

	data, err := er.GetEnergies(sod, eod)
	require.NoError(t, err)
	require.Len(t, data, 288)

	usage := NewUsage(site, db, client, logger)
	usages := usage.GetUsagesFromData(site, data)
	require.NoError(t, err)

	require.Len(t, usages, 2)
	require.Equal(t, "OFF_PEAK", usages[0].Tariff.Name)
	require.Equal(t, "ON_PEAK", usages[1].Tariff.Name)

	// off peak
	require.Equal(t, 2401.375, usages[0].GridUsage)
	require.Equal(t, 7273.375, usages[0].HomeUsage)
	require.Equal(t, -2041.00, usages[0].BatteryChange)
	require.Equal(t, 2831.0, usages[0].SolarProduction)

	// on peak
	require.Equal(t, -38000.875, usages[1].GridUsage)
	require.Equal(t, 19766.375, usages[1].HomeUsage)
	require.Equal(t, 6551.0, usages[1].BatteryChange)
	require.Equal(t, 64318.25, usages[1].SolarProduction)

	r := TotalUsage(usages)
	require.Equal(t, -35599.5, r.GridUsage)
	require.Equal(t, 27039.75, r.HomeUsage)
	require.Equal(t, 4510.0, r.BatteryChange)
	require.Equal(t, 67149.25, r.SolarProduction)

	from_db, err := usage.GetEnergyUsage(sod, eod)
	require.NoError(t, err)
	require.ElementsMatch(t, usages, from_db)
}

func TotalUsage(usages []UsageData) UsageData {
	var result UsageData

	for _, u := range usages {
		result.HomeUsage += u.HomeUsage
		result.GridUsage += u.GridUsage
		result.SolarProduction += u.SolarProduction
		result.BatteryChange += u.BatteryChange
	}
	return result
}
